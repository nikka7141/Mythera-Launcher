//! Delta-sync a server instance: download new/changed files (sha256-verified), delete stale ones.
//! Port of electron/sync-engine.ts. The pure planning lives in `sync_plan`.

use crate::error::{AppError, AppResult};
use crate::sync_plan::{compute_sync_plan, LocalFile, ManifestFile};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub phase: String, // "scan" | "download" | "cleanup" | "done"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub done: usize,
    pub total: usize,
}

impl SyncProgress {
    fn new(phase: &str, file: Option<String>, done: usize, total: usize) -> Self {
        Self { phase: phase.to_string(), file, done, total }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub downloaded: usize,
    pub deleted: usize,
    pub unchanged: usize,
}

// Only these dirs are managed by sync — the base client (versions/, libraries/, assets/, version.json)
// lives in the same instance and must NEVER be deleted as "extra".
const MANAGED_DIRS: [&str; 4] = ["mods", "coremods", "config", "resourcepacks"];

fn sha256_bytes(buf: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(buf);
    hex::encode(h.finalize())
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<LocalFile>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // dir not present yet
    };
    for entry in entries.flatten() {
        let abs = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk(root, &abs, out);
        } else if ft.is_file() {
            if let Ok(buf) = std::fs::read(&abs) {
                let rel = abs
                    .strip_prefix(root)
                    .unwrap_or(&abs)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(LocalFile { rel_path: rel, sha256: sha256_bytes(&buf) });
            }
        }
    }
}

fn scan_local(root: &Path) -> Vec<LocalFile> {
    let mut out = Vec::new();
    for d in MANAGED_DIRS {
        walk(root, &root.join(d), &mut out);
    }
    out
}

/// Resolve a manifest relPath to an absolute dest, refusing anything outside the managed surface or
/// that escapes the instance dir (defense against a hostile/misconfigured manifest).
fn safe_dest(dir: &Path, rel: &str) -> AppResult<PathBuf> {
    let norm = rel.replace('\\', "/");
    let trimmed = norm.trim_start_matches('/');
    let top = trimmed.split('/').next().unwrap_or("");
    if !MANAGED_DIRS.contains(&top) {
        return Err(AppError::msg(format!("Refusing file outside managed dirs: {rel}")));
    }
    // Reject `..` / empty / absolute segments — a hostile manifest must not escape the instance dir.
    if trimmed.split('/').any(|c| c == ".." || c.is_empty()) {
        return Err(AppError::msg(format!("Unsafe path escapes instance: {rel}")));
    }
    Ok(dir.join(trimmed))
}

pub async fn sync_server(
    http: &reqwest::Client,
    dir: &Path,
    manifest: &[ManifestFile],
    on_progress: &(dyn Fn(SyncProgress) + Send + Sync),
    is_canceled: &(dyn Fn() -> bool + Send + Sync),
) -> AppResult<SyncResult> {
    tokio::fs::create_dir_all(dir).await?;
    on_progress(SyncProgress::new("scan", None, 0, 0));

    let local = scan_local(dir);
    let plan = compute_sync_plan(manifest, &local);

    let total = plan.to_download.len();
    let mut done = 0usize;
    for f in &plan.to_download {
        // User-requested abort: stop before the next file (already-written files stay; a later sync repairs).
        if is_canceled() {
            return Err(AppError::msg("canceled"));
        }
        on_progress(SyncProgress::new("download", Some(f.rel_path.clone()), done, total));
        let res = http.get(&f.cdn_url).send().await?;
        if !res.status().is_success() {
            return Err(AppError::msg(format!("Download failed ({}) for {}", res.status().as_u16(), f.rel_path)));
        }
        let buf = res.bytes().await?.to_vec();
        if sha256_bytes(&buf) != f.sha256 {
            return Err(AppError::msg(format!("Checksum mismatch for {}", f.rel_path)));
        }
        let dest = safe_dest(dir, &f.rel_path)?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&dest, &buf).await?;
        done += 1;
        on_progress(SyncProgress::new("download", Some(f.rel_path.clone()), done, total));
    }

    on_progress(SyncProgress::new("cleanup", None, done, total));
    for rel in &plan.to_delete {
        if let Ok(dest) = safe_dest(dir, rel) {
            let _ = tokio::fs::remove_file(&dest).await;
        }
    }

    on_progress(SyncProgress::new("done", None, done, total));
    Ok(SyncResult {
        downloaded: plan.to_download.len(),
        deleted: plan.to_delete.len(),
        unchanged: plan.unchanged,
    })
}
