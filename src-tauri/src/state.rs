//! Shared app state: the baked API base URL, a shared HTTP client, the platform data dirs, and the
//! single-running-game guard. Mirrors the Electron main's module-level state.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

pub struct AppState {
    /// Backend base, e.g. https://api.mythera.ge/api/v1 (baked at build, overridable via MC_API_URL).
    pub api_base: String,
    pub http: reqwest::Client,
    /// %APPDATA% (Roaming). Instances live under <data_root>/.mythera/<slug> — same as the old launcher.
    pub data_root: PathBuf,
    /// Runtime/JRE root: <data_root>/Mythera (matches the old Electron userData so JREs are reused).
    pub user_data: PathBuf,
    /// server_id of the currently-running game, if any (at most one runs at a time).
    pub running: Mutex<Option<i64>>,
    /// server_ids whose in-flight install/sync should abort at the next file (set by cancel_sync).
    pub cancel: Mutex<HashSet<i64>>,
    /// Set while a self-update download/install is in flight, so a double-click / relaunch can't start a
    /// second download to the same temp path (re-entrancy guard for `update_now`).
    pub updating: AtomicBool,
}

impl AppState {
    /// Per-server instance dir under %AppData%/.mythera/<slug> (readable, slug sanitized).
    pub fn instance_dir(&self, slug: &str) -> PathBuf {
        let safe: String = slug
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
            .collect();
        let safe = if safe.is_empty() { "server".to_string() } else { safe };
        self.data_root.join(".mythera").join(safe)
    }
}
