//! Pure delta-sync planning — the heart of the launcher.
//!
//! No filesystem / network / Electron deps, so it is fully unit-testable.
//! This is a faithful port of `electron/sync-plan.ts`.

use std::collections::{HashMap, HashSet};

/// One file as described by the server manifest (the desired end state).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub rel_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub cdn_url: String,
}

/// One file currently present on disk locally.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub rel_path: String,
    pub sha256: String,
}

/// The computed sync plan.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    /// New or changed files (sha256 differs, or missing locally).
    pub to_download: Vec<ManifestFile>,
    /// Local files no longer present in the manifest.
    pub to_delete: Vec<String>,
    /// Count of manifest files already up-to-date.
    pub unchanged: usize,
}

/// Returns the current OS in launcher canonical form.
pub fn current_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

/// Compute the delta-sync plan from the desired manifest and the local state.
///
/// Invariants (mirroring the TS source exactly):
/// - `to_download` = manifest files whose local sha for the same `rel_path`
///   differs from the manifest sha. A missing local entry counts as "changed",
///   because `localBySha.get(rel_path)` is absent (`!= sha`) -> downloaded.
/// - `to_delete` = local `rel_path`s not present in the manifest set.
/// - `unchanged` = `manifest.len() - to_download.len()`.
///
/// Note: like the TS `Map`/`Set` built from arrays, later entries with a
/// duplicate `rel_path` overwrite earlier ones for the local-sha lookup.
pub fn compute_sync_plan(manifest: &[ManifestFile], local: &[LocalFile]) -> SyncPlan {
    let local_by_sha: HashMap<&str, &str> = local
        .iter()
        .map(|f| (f.rel_path.as_str(), f.sha256.as_str()))
        .collect();
    let wanted: HashSet<&str> = manifest.iter().map(|f| f.rel_path.as_str()).collect();

    let to_download: Vec<ManifestFile> = manifest
        .iter()
        .filter(|f| local_by_sha.get(f.rel_path.as_str()) != Some(&f.sha256.as_str()))
        .cloned()
        .collect();

    let to_delete: Vec<String> = local
        .iter()
        .filter(|f| !wanted.contains(f.rel_path.as_str()))
        .map(|f| f.rel_path.clone())
        .collect();

    let unchanged = manifest.len() - to_download.len();

    SyncPlan {
        to_download,
        to_delete,
        unchanged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirror of the spec's `m()` factory.
    fn m(rel_path: &str, sha256: &str) -> ManifestFile {
        ManifestFile {
            rel_path: rel_path.to_string(),
            sha256: sha256.to_string(),
            size_bytes: 1,
            cdn_url: format!("https://cdn/{rel_path}"),
        }
    }

    /// Mirror of the spec's `l()` factory.
    fn l(rel_path: &str, sha256: &str) -> LocalFile {
        LocalFile {
            rel_path: rel_path.to_string(),
            sha256: sha256.to_string(),
        }
    }

    fn rel_paths(files: &[ManifestFile]) -> Vec<String> {
        files.iter().map(|f| f.rel_path.clone()).collect()
    }

    #[test]
    fn downloads_new_files() {
        let plan = compute_sync_plan(&[m("mods/a.jar", "aa")], &[]);
        assert_eq!(rel_paths(&plan.to_download), vec!["mods/a.jar"]);
        assert_eq!(plan.to_delete, Vec::<String>::new());
        assert_eq!(plan.unchanged, 0);
    }

    #[test]
    fn re_downloads_changed_files_sha_differs() {
        let plan = compute_sync_plan(&[m("mods/a.jar", "bb")], &[l("mods/a.jar", "aa")]);
        assert_eq!(rel_paths(&plan.to_download), vec!["mods/a.jar"]);
        assert_eq!(plan.unchanged, 0);
    }

    #[test]
    fn skips_unchanged_files() {
        let plan = compute_sync_plan(&[m("mods/a.jar", "aa")], &[l("mods/a.jar", "aa")]);
        assert!(plan.to_download.is_empty());
        assert_eq!(plan.unchanged, 1);
    }

    #[test]
    fn deletes_local_files_not_in_manifest() {
        let plan = compute_sync_plan(
            &[m("mods/a.jar", "aa")],
            &[l("mods/a.jar", "aa"), l("mods/old.jar", "cc")],
        );
        assert_eq!(plan.to_delete, vec!["mods/old.jar"]);
    }

    #[test]
    fn handles_a_mixed_plan() {
        let plan = compute_sync_plan(
            &[m("a", "1"), m("b", "2"), m("c", "3")],
            &[l("a", "1"), l("b", "X"), l("d", "9")],
        );
        let mut dl = rel_paths(&plan.to_download);
        dl.sort();
        assert_eq!(dl, vec!["b", "c"]);
        assert_eq!(plan.to_delete, vec!["d"]);
        assert_eq!(plan.unchanged, 1);
    }

    // --- extra edge cases ---

    #[test]
    fn empty_manifest_and_local_is_noop() {
        let plan = compute_sync_plan(&[], &[]);
        assert!(plan.to_download.is_empty());
        assert!(plan.to_delete.is_empty());
        assert_eq!(plan.unchanged, 0);
    }

    #[test]
    fn empty_manifest_deletes_all_local() {
        let plan = compute_sync_plan(&[], &[l("x", "1"), l("y", "2")]);
        assert!(plan.to_download.is_empty());
        assert_eq!(plan.to_delete, vec!["x", "y"]);
        assert_eq!(plan.unchanged, 0);
    }

    #[test]
    fn preserves_manifest_order_in_to_download() {
        let plan = compute_sync_plan(
            &[m("z", "1"), m("a", "1"), m("m", "1")],
            &[],
        );
        assert_eq!(rel_paths(&plan.to_download), vec!["z", "a", "m"]);
    }

    #[test]
    fn current_os_is_known_value() {
        assert!(matches!(current_os(), "windows" | "osx" | "linux"));
    }
}
