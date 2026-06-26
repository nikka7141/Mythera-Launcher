//! Session-at-rest in the OS keychain (Windows Credential Manager via `keyring`), never plaintext —
//! the Tauri equivalent of the former Electron `safeStorage` session.bin. The `user` field is kept as
//! a raw JSON value so whatever the backend returns round-trips to the renderer unchanged.

use crate::error::{AppError, AppResult};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const SERVICE: &str = "com.mythera.launcher";
const ACCOUNT: &str = "session";

// ---- launcher-local preferences (non-sensitive → a plain JSON file in user_data, not the keychain) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub ram_mb: u32,
    pub max_ram_mb: u32,
    pub performance_mode: bool,
    pub fullscreen: bool,
    pub close_on_play: bool,
    pub game_dir: String,
    pub auto_update: bool,
}

impl Settings {
    pub fn defaults(game_dir: String) -> Self {
        Settings {
            ram_mb: 4096,
            max_ram_mb: 16384,
            performance_mode: false,
            fullscreen: false,
            close_on_play: false,
            game_dir,
            auto_update: true,
        }
    }
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

/// Load saved settings (or sensible defaults seeded with the real game dir).
pub fn load_settings(dir: &Path, default_game_dir: String) -> Settings {
    match fs::read_to_string(settings_path(dir)) {
        Ok(txt) => serde_json::from_str(&txt).unwrap_or_else(|_| Settings::defaults(default_game_dir)),
        Err(_) => Settings::defaults(default_game_dir),
    }
}

pub fn save_settings(dir: &Path, settings: &Settings) -> AppResult<()> {
    let _ = fs::create_dir_all(dir);
    let json = serde_json::to_string_pretty(settings)?;
    fs::write(settings_path(dir), json).map_err(|e| AppError::msg(format!("settings save: {e}")))
}

/// JVM heap (MB) from saved settings, clamped, for launch. Falls back to 2048 when unset/unreadable.
pub fn launch_ram_mb(dir: &Path) -> u32 {
    fs::read_to_string(settings_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
        .map(|s| s.ram_mb.clamp(1024, 65536))
        .unwrap_or(2048)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub user: Value,
}

fn entry() -> AppResult<Entry> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| AppError::msg(format!("keyring: {e}")))
}

pub fn save(session: &Session) -> AppResult<()> {
    let json = serde_json::to_string(session)?;
    entry()?
        .set_password(&json)
        .map_err(|e| AppError::msg(format!("keyring save: {e}")))
}

pub fn load() -> Option<Session> {
    let e = entry().ok()?;
    let json = e.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

pub fn clear() {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
}
