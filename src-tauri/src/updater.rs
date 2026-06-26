//! Self-update + version gating. Preserves the EXISTING backend contract: GET /launcher/version returns
//! { latest, minSupported, feedUrl }. We gate with semver (same as before) and, on update, download the
//! NSIS installer from the feed (`<feedUrl>/Mythera-<latest>-setup.exe`) and run it in place. No backend
//! change needed — the admin just uploads the Tauri installer under that name (CI renames it to match).

use crate::error::{AppError, AppResult};
use crate::version_gate::gate;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloads {
    #[serde(default)]
    pub windows: Option<String>,
    #[serde(default)]
    pub mac: Option<String>,
    #[serde(default)]
    pub linux: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub latest: String,
    pub min_supported: String,
    pub feed_url: String,
    /// Per-OS public download URLs (whitelist-aware: backend points these at the version this user may get).
    #[serde(default)]
    pub downloads: Downloads,
}

/// Filename extension used for this OS's installer (the CI artifact naming convention).
fn os_ext() -> &'static str {
    if cfg!(target_os = "windows") {
        "setup.exe"
    } else if cfg!(target_os = "macos") {
        "dmg"
    } else {
        "AppImage"
    }
}

/// Resolve the installer URL for the CURRENT OS from the backend-provided per-OS download URL
/// (whitelist-aware). The backend is the single source of truth for the artifact filename — we must NOT
/// invent one. The real Tauri/NSIS artifact is `Mythera_<latest>_x64-setup.exe` (underscores), not a
/// guessable dashed name, so a constructed URL would 404. If no download is published for this OS,
/// surface a clear error instead.
pub fn installer_url(info: &VersionInfo) -> AppResult<String> {
    let provided = if cfg!(target_os = "windows") {
        info.downloads.windows.as_ref()
    } else if cfg!(target_os = "macos") {
        info.downloads.mac.as_ref()
    } else {
        info.downloads.linux.as_ref()
    };
    match provided {
        Some(u) if !u.is_empty() => Ok(u.clone()),
        _ => Err(AppError::msg(
            "No update is available for your operating system yet. Please try again later or download the latest version manually.",
        )),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub latest: String,
    pub min_supported: String,
    pub must_update: bool,
    pub update_available: bool,
    pub packaged: bool,
}

/// Version-gating decision from the backend payload (mirrors electron/updater.ts computeStatus).
pub fn compute_status(info: &VersionInfo, current: &str) -> UpdateStatus {
    let g = gate(current, &info.latest, &info.min_supported);
    UpdateStatus {
        current: current.to_string(),
        latest: info.latest.clone(),
        min_supported: info.min_supported.clone(),
        must_update: g.must_update,
        update_available: g.update_available,
        packaged: !cfg!(debug_assertions),
    }
}

/// Download the latest NSIS installer from the feed to `dir`, reporting integer percent. Returns its path.
pub async fn download_installer(
    http: &reqwest::Client,
    info: &VersionInfo,
    dir: &Path,
    on_progress: &(dyn Fn(u8) + Send + Sync),
) -> AppResult<PathBuf> {
    let url = installer_url(info)?;
    let res = http.get(&url).send().await?;
    if !res.status().is_success() {
        return Err(AppError::msg(format!("Update download failed ({})", res.status().as_u16())));
    }
    let total = res.content_length().unwrap_or(0);
    // Download into a UNIQUE per-run subdir (pid + timestamp) so a previous, possibly still file-locked,
    // installer at the old FIXED path can't collide with this one — that collision was the Windows
    // os error 32 (sharing violation) on File::create.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let run_dir = dir.join(format!("{}-{}", std::process::id(), ts));
    tokio::fs::create_dir_all(&run_dir).await?;
    // Keep the artifact's real filename (its extension drives how we run it per OS).
    let name = url.rsplit('/').next().unwrap_or("").trim();
    let name = if name.is_empty() { format!("Mythera-{}.{}", info.latest, os_ext()) } else { name.to_string() };
    let dest = run_dir.join(name);

    // Best-effort: clear any stale file at this exact path before (re)creating it.
    let _ = tokio::fs::remove_file(&dest).await;
    let mut file = match tokio::fs::File::create(&dest).await {
        Ok(f) => f,
        Err(e) if e.raw_os_error() == Some(32) => {
            return Err(AppError::msg(
                "Couldn't write the update because the file is in use. Close any running Mythera installer and try again.",
            ));
        }
        Err(e) => return Err(AppError::from(e)),
    };
    let mut downloaded: u64 = 0;
    let mut last_pct: u8 = 0;
    let mut stream = res.bytes_stream();
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let pct = ((downloaded * 100) / total).min(100) as u8;
            if pct != last_pct {
                last_pct = pct;
                on_progress(pct);
            }
        }
    }
    file.flush().await?;
    Ok(dest)
}

/// Run a downloaded installer for the current OS. Returns once the installer has been launched
/// (the caller then exits the app). Windows: run the NSIS .exe. Linux: mark the AppImage executable
/// and launch it. macOS: open the .dmg so the user can drag the app to Applications.
pub fn run_installer(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(path).spawn().map_err(AppError::from)?;
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)?;
        std::process::Command::new(path).spawn().map_err(AppError::from)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn().map_err(AppError::from)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(downloads: Downloads) -> VersionInfo {
        VersionInfo {
            latest: "1.2.3".into(),
            min_supported: "1.0.0".into(),
            feed_url: "https://api.mythera.ge/cdn/launcher/".into(),
            downloads,
        }
    }

    #[test]
    fn prefers_backend_provided_url() {
        let d = Downloads {
            windows: Some("https://cdn/x/win.exe".into()),
            mac: Some("https://cdn/x/app.dmg".into()),
            linux: Some("https://cdn/x/app.AppImage".into()),
        };
        let url = installer_url(&info(d)).unwrap();
        // The host OS's provided URL is used verbatim.
        let expected = if cfg!(target_os = "windows") {
            "https://cdn/x/win.exe"
        } else if cfg!(target_os = "macos") {
            "https://cdn/x/app.dmg"
        } else {
            "https://cdn/x/app.AppImage"
        };
        assert_eq!(url, expected);
    }

    #[test]
    fn errors_when_no_download_for_this_os() {
        // The backend owns the artifact filename; we must NOT invent one (a guessed name 404s), so a
        // payload with no per-OS download must be an error rather than a fabricated URL.
        assert!(installer_url(&info(Downloads::default())).is_err());
    }

    #[test]
    fn errors_when_provided_url_is_empty() {
        let d = Downloads { windows: Some("".into()), mac: Some("".into()), linux: Some("".into()) };
        assert!(installer_url(&info(d)).is_err());
    }
}
