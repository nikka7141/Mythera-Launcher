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

// Mod jars are DELTA-synced + pruned. config/ is handled separately (force-overwritten, never pruned —
// see CONFIG_DIRS). resourcepacks/ stays excluded. The base client (versions/, libraries/, assets/,
// version.json) lives in the same instance and must NEVER be deleted as "extra".
const MANAGED_DIRS: [&str; 2] = ["mods", "coremods"];

// Admin-published configs: the SERVER's copy is the source of truth. We FORCE-overwrite these on every
// launch (no sha verify — a mod-rewritten .properties/.toml/.json with a timestamp header would otherwise
// "Checksum mismatch") and NEVER prune unpublished local configs (a mod still generates its own). This
// lets the owner lock server configs the player must not change, with no client⇄server mismatch.
const CONFIG_DIRS: [&str; 1] = ["config"];

/// Top path segment of a manifest relPath ("config/foo.toml" -> "config"), separator-agnostic.
fn top_seg(rel: &str) -> &str {
    rel.trim_start_matches(|c| c == '/' || c == '\\')
        .split(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("")
}

/// Keep only manifest entries inside the managed (mod) dirs; everything else the backend still lists
/// (server configs, resourcepacks) is ignored — neither downloaded nor used to prune local files.
fn managed_only(manifest: &[ManifestFile]) -> Vec<ManifestFile> {
    manifest
        .iter()
        .filter(|f| MANAGED_DIRS.contains(&top_seg(&f.rel_path)))
        .cloned()
        .collect()
}

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
    if !MANAGED_DIRS.contains(&top) && !CONFIG_DIRS.contains(&top) {
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
    // Sync mod jars only: drop any manifest entry outside the managed dirs (server-side config/.toml/
    // .json, resourcepacks) so the client downloads ONLY mods and never prunes its own configs.
    let wanted = managed_only(manifest);
    let plan = compute_sync_plan(&wanted, &local);

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

    // Force-apply admin-published configs from the server on EVERY launch (prepare_instance → sync_server
    // runs each play). Best-effort + sha-free: a config fetch failure or a churning timestamp must never
    // block the launch or throw a "Checksum mismatch". Unpublished local configs are left untouched.
    let configs: Vec<&ManifestFile> = manifest
        .iter()
        .filter(|f| CONFIG_DIRS.contains(&top_seg(&f.rel_path)))
        .collect();
    for (i, f) in configs.iter().enumerate() {
        if is_canceled() {
            return Err(AppError::msg("canceled"));
        }
        let dest = match safe_dest(dir, &f.rel_path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        on_progress(SyncProgress::new("config", Some(f.rel_path.clone()), i, configs.len()));
        let res = match http.get(&f.cdn_url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => continue, // best-effort
        };
        let buf = match res.bytes().await {
            Ok(b) => b.to_vec(),
            Err(_) => continue,
        };
        if let Some(parent) = dest.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&dest, &buf).await;
    }

    on_progress(SyncProgress::new("done", None, done, total));
    Ok(SyncResult {
        downloaded: plan.to_download.len(),
        deleted: plan.to_delete.len(),
        unchanged: plan.unchanged,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_plan::ManifestFile;

    fn m(rel: &str) -> ManifestFile {
        ManifestFile { rel_path: rel.into(), sha256: "x".into(), size_bytes: 1, cdn_url: "u".into() }
    }

    #[test]
    fn top_seg_is_separator_agnostic() {
        assert_eq!(top_seg("config/foo.toml"), "config");
        assert_eq!(top_seg("mods\\a.jar"), "mods");
        assert_eq!(top_seg("/mods/a.jar"), "mods");
        assert_eq!(top_seg("a.jar"), "a.jar");
    }

    #[test]
    fn managed_only_keeps_mods_drops_config_and_resourcepacks() {
        let out = managed_only(&[
            m("mods/a.jar"),
            m("config/a.toml"),
            m("config/sub/b.json"),
            m("resourcepacks/p.zip"),
            m("coremods/c.jar"),
        ]);
        let rels: Vec<_> = out.iter().map(|f| f.rel_path.clone()).collect();
        assert_eq!(rels, vec!["mods/a.jar", "coremods/c.jar"]);
    }
}
