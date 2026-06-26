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

/// Resolve the installer URL for the CURRENT OS: prefer the backend-provided per-OS download URL
/// (whitelist-aware), falling back to the legacy `<feedUrl>/Mythera-<latest>-<ext>` convention.
pub fn installer_url(info: &VersionInfo) -> String {
    let provided = if cfg!(target_os = "windows") {
        info.downloads.windows.as_ref()
    } else if cfg!(target_os = "macos") {
        info.downloads.mac.as_ref()
    } else {
        info.downloads.linux.as_ref()
    };
    if let Some(u) = provided {
        if !u.is_empty() {
            return u.clone();
        }
    }
    let base = info.feed_url.trim_end_matches('/');
    let ext = os_ext();
    if cfg!(target_os = "windows") {
        format!("{base}/Mythera-{}-{ext}", info.latest)
    } else {
        format!("{base}/Mythera-{}.{ext}", info.latest)
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
    let url = installer_url(info);
    let res = http.get(&url).send().await?;
    if !res.status().is_success() {
        return Err(AppError::msg(format!("Update download failed ({})", res.status().as_u16())));
    }
    let total = res.content_length().unwrap_or(0);
    tokio::fs::create_dir_all(dir).await?;
    // Keep the artifact's real filename (its extension drives how we run it per OS).
    let name = url.rsplit('/').next().unwrap_or("").trim();
    let name = if name.is_empty() { format!("Mythera-{}.{}", info.latest, os_ext()) } else { name.to_string() };
    let dest = dir.join(name);

    let mut file = tokio::fs::File::create(&dest).await?;
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
        let url = installer_url(&info(d));
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
    fn falls_back_to_feed_convention_with_correct_extension() {
        let url = installer_url(&info(Downloads::default()));
        assert!(url.starts_with("https://api.mythera.ge/cdn/launcher/Mythera-1.2.3"));
        if cfg!(target_os = "windows") {
            assert!(url.ends_with("Mythera-1.2.3-setup.exe"));
        } else if cfg!(target_os = "macos") {
            assert!(url.ends_with("Mythera-1.2.3.dmg"));
        } else {
            assert!(url.ends_with("Mythera-1.2.3.AppImage"));
        }
    }

    #[test]
    fn empty_provided_url_falls_back() {
        let d = Downloads { windows: Some("".into()), mac: Some("".into()), linux: Some("".into()) };
        let url = installer_url(&info(d));
        assert!(url.contains("Mythera-1.2.3"));
    }
}
