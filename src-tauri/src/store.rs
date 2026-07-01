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

// File fallback for platforms/builds where the OS keychain is unavailable or can't read back what it
// wrote — notably UNSIGNED macOS apps, whose Keychain ACL is bound to a signing identity they don't have.
// Lives beside settings.json in the app data dir; user-private, plaintext (a refreshable session token).
fn session_file() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("Mythera").join("session.dat"))
}

fn file_load() -> Option<String> {
    fs::read_to_string(session_file()?).ok()
}

fn file_save(json: &str) -> AppResult<()> {
    let path = session_file().ok_or_else(|| AppError::msg("no data dir for session fallback"))?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, json).map_err(|e| AppError::msg(format!("session save: {e}")))
}

fn file_clear() {
    if let Some(p) = session_file() {
        let _ = fs::remove_file(p);
    }
}

fn keychain_load() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn save(session: &Session) -> AppResult<()> {
    let json = serde_json::to_string(session)?;
    // Prefer the OS keychain (encrypted at rest), but VERIFY the value actually round-trips — an unsigned
    // macOS app can write to the Keychain yet fail to read it back. Only trust it when the read-back matches;
    // otherwise persist to the file fallback so the session survives a restart.
    let keychain_ok = entry()
        .and_then(|e| e.set_password(&json).map_err(|err| AppError::msg(format!("keyring save: {err}"))))
        .is_ok()
        && keychain_load().as_deref() == Some(json.as_str());
    if keychain_ok {
        file_clear(); // keychain works here → don't leave a stale plaintext copy around
    } else {
        file_save(&json)?;
    }
    Ok(())
}

pub fn load() -> Option<Session> {
    let json = keychain_load().or_else(file_load)?;
    serde_json::from_str(&json).ok()
}

pub fn clear() {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
    file_clear();
}
