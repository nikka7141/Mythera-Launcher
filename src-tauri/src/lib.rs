// Mythera launcher — Tauri (Rust) backend. Replaces the former Electron main process; the React
// renderer (../src) is reused and talks to these #[tauri::command]s via the mc-bridge shim.
#![cfg_attr(not(debug_assertions), allow(dead_code))]

mod commands;
mod error;
mod http;
mod install;
mod jre;
mod launch;
mod state;
mod store;
mod sync;
mod updater;

// Pure-logic modules (ported 1:1 from electron/*.ts, with unit tests).
mod launch_args;
mod offline_uuid;
mod resolver;
mod sync_plan;
mod version_gate;

use state::AppState;
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::Manager;

/// Backend base URL. Precedence: runtime MC_API_URL > compile-time bake (build.rs from .env.production)
/// > localhost dev default.
fn resolve_api_base() -> String {
    if let Ok(v) = std::env::var("MC_API_URL") {
        if !v.is_empty() {
            return v;
        }
    }
    if let Some(v) = option_env!("MYTHERA_API_URL") {
        if !v.is_empty() {
            return v.to_string();
        }
    }
    "http://localhost:3001/api/v1".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // %APPDATA% (Roaming): instances under <data_root>/.mythera/<slug>; JRE under <data_root>/Mythera.
            let data_root = app.path().data_dir().expect("could not resolve app data dir");
            let user_data = data_root.join("Mythera");
            let http = reqwest::Client::builder()
                .user_agent("Mythera-Launcher")
                .build()
                .expect("could not build http client");
            app.manage(AppState {
                api_base: resolve_api_base(),
                http,
                data_root,
                user_data,
                running: Mutex::new(None),
                cancel: Mutex::new(HashSet::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::login,
            commands::register,
            commands::recover_lookup,
            commands::recover_reset,
            commands::logout,
            commands::session,
            commands::refresh_user,
            commands::upload_skin,
            commands::servers,
            commands::set_favorite,
            commands::server_status,
            commands::installed,
            commands::install,
            commands::sync_server,
            commands::cancel_sync,
            commands::launch,
            commands::update_status,
            commands::update_now,
            commands::get_settings,
            commands::save_settings,
            commands::browse_game_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Mythera launcher");
}
