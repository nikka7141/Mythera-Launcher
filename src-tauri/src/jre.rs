//! Bundled Java runtime management — port of electron/jre.ts. Resolves a previously-installed JRE or
//! downloads a Temurin <major> JRE from Adoptium and extracts it. 1.7.10 + LWJGL 2.9.x REQUIRE Java 8.

use crate::error::{AppError, AppResult};
use crate::http;
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
const JAVA_EXE: &str = "javaw.exe";
#[cfg(not(target_os = "windows"))]
const JAVA_EXE: &str = "java";

fn adoptium_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

fn adoptium_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x64"
    }
}

/// Recursively find a `bin/<exe>` under dir.
fn find_exe(dir: &Path, exe: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if let Some(found) = find_exe(&p, exe) {
                return Some(found);
            }
        } else if entry.file_name().to_string_lossy() == exe
            && p.parent().and_then(|d| d.file_name()).map(|n| n == "bin").unwrap_or(false)
        {
            return Some(p);
        }
    }
    None
}

/// Resolve a Java path without downloading: MC_JAVA_PATH, a previously-installed jre8 marker, then PATH.
pub fn resolve_java_path(user_data: &Path) -> String {
    if let Ok(p) = std::env::var("MC_JAVA_PATH") {
        if Path::new(&p).exists() {
            return p;
        }
    }
    let marker = user_data.join("runtime").join("jre8").join("java-path.txt");
    if let Ok(p) = std::fs::read_to_string(&marker) {
        let p = p.trim();
        if !p.is_empty() && Path::new(p).exists() {
            return p.to_string();
        }
    }
    if cfg!(target_os = "windows") { "javaw".into() } else { "java".into() }
}

/// Ensure a bundled Java <major> JRE exists (download Temurin if needed). Returns the java(w) exe path.
pub async fn ensure_java(
    http_client: &reqwest::Client,
    major: u32,
    user_data: &Path,
    on_log: &(dyn Fn(&str) + Send + Sync),
) -> AppResult<String> {
    if major == 8 {
        if let Ok(p) = std::env::var("MC_JAVA_PATH") {
            if Path::new(&p).exists() {
                return Ok(p);
            }
        }
    }

    let runtime_dir = user_data.join("runtime").join(format!("jre{major}"));
    let marker = runtime_dir.join("java-path.txt");
    if let Ok(resolved) = std::fs::read_to_string(&marker) {
        let resolved = resolved.trim();
        if !resolved.is_empty() && Path::new(resolved).exists() {
            return Ok(resolved.to_string());
        }
    }

    let os = adoptium_os();
    let arch = adoptium_arch();
    let url = format!(
        "https://api.adoptium.net/v3/binary/latest/{major}/ga/{os}/{arch}/jre/hotspot/normal/eclipse"
    );
    on_log(&format!("Downloading Java {major} JRE ({os}/{arch})…"));
    let buf = http::get_bytes(http_client, &url).await?;
    tokio::fs::create_dir_all(&runtime_dir).await?;

    // Extract (blocking) off the async runtime. Windows ships a zip; *nix a tar.gz.
    let runtime_dir2 = runtime_dir.clone();
    let is_windows = cfg!(target_os = "windows");
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        if is_windows {
            let cursor = std::io::Cursor::new(buf);
            let mut archive = zip::ZipArchive::new(cursor)?;
            archive.extract(&runtime_dir2)?;
        } else {
            let tgz = runtime_dir2.join("jre.tar.gz");
            std::fs::write(&tgz, &buf)?;
            let status = std::process::Command::new("tar")
                .arg("-xzf")
                .arg(&tgz)
                .arg("-C")
                .arg(&runtime_dir2)
                .status()?;
            if !status.success() {
                return Err(AppError::msg("tar extract failed"));
            }
            let _ = std::fs::remove_file(&tgz);
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::msg(format!("extract task panicked: {e}")))??;

    let java_path = find_exe(&runtime_dir, JAVA_EXE)
        .ok_or_else(|| AppError::msg("java executable not found after JRE extract"))?;
    let java_path = java_path.to_string_lossy().to_string();
    tokio::fs::write(&marker, &java_path).await?;
    on_log(&format!("Java {major} ready: {java_path}"));
    Ok(java_path)
}

/// The console `java` exe next to a `javaw` exe (for running the Forge installer with captured output).
pub fn console_java(javaw_path: &str) -> String {
    // Replace trailing javaw(.exe) -> java(.exe), case-insensitively.
    let lower = javaw_path.to_lowercase();
    if let Some(idx) = lower.rfind("javaw") {
        let mut out = javaw_path.to_string();
        // "javaw" is 5 chars; keep whatever case/suffix followed (e.g. ".exe").
        out.replace_range(idx..idx + 5, "java");
        out
    } else {
        javaw_path.to_string()
    }
}
