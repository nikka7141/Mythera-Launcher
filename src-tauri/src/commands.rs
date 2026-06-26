//! Tauri commands — the renderer-facing API. 1:1 with the old Electron preload `window.mc`. They emit
//! the same events (mc:sync-progress, mc:launch-log, mc:launch-exit, mc:update-progress, mc:update-error).

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::{self, Session};
use crate::sync::SyncProgress;
use crate::sync_plan::ManifestFile;
use crate::{http, install, jre, launch, sync, updater};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerManifestLite {
    slug: String,
    #[serde(default)]
    mc_version: String,
    #[serde(default)]
    loader: String,
    #[serde(default)]
    loader_version: String,
    #[serde(default)]
    java_version: u32,
    #[serde(default)]
    files: Vec<ManifestFile>,
}

fn is_modern(mc: &str) -> bool {
    mc.split('.').nth(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0) >= 13
}

/// JVM heap (MB): explicit MC_MAX_MEM env override > the user's saved Settings (settings.json) > 2048.
fn max_memory_mb(st: &AppState) -> u32 {
    std::env::var("MC_MAX_MEM")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| store::launch_ram_mb(&st.user_data))
}

struct Prepared {
    dir: PathBuf,
    mc: String,
    modern: bool,
    profile_id: String,
    java_path: String,
}

/// Ensure the right client (Forge/vanilla, legacy/modern) + Java are installed. Idempotent.
async fn prepare_instance(
    st: &AppState,
    m: &ServerManifestLite,
    on_log: &(dyn Fn(&str) + Send + Sync),
) -> AppResult<Prepared> {
    let dir = st.instance_dir(&m.slug);
    let mc = if m.mc_version.is_empty() { "1.7.10".to_string() } else { m.mc_version.clone() };

    if is_modern(&mc) {
        let major = if m.java_version >= 8 { m.java_version } else { 17 };
        install::ensure_client_installed(&st.http, &dir, &mc, on_log).await?;
        let java_path = jre::ensure_java(&st.http, major, &st.user_data, on_log).await?;
        let mut profile_id = mc.clone();
        if m.loader == "forge" && !m.loader_version.is_empty() {
            profile_id = install::ensure_modern_forge_installed(
                &st.http,
                &dir,
                &mc,
                &m.loader_version,
                &jre::console_java(&java_path),
                on_log,
            )
            .await?;
        } else if !m.loader.is_empty() && m.loader != "vanilla" {
            on_log(&format!("[note] {} {} not supported yet — vanilla base only.", m.loader, mc));
        }
        return Ok(Prepared { dir, mc, modern: true, profile_id, java_path });
    }

    // legacy (<= 1.12.2)
    if m.loader == "forge" && !m.loader_version.is_empty() {
        install::ensure_forge_installed(&st.http, &dir, &mc, &m.loader_version, on_log).await?;
    } else {
        if !m.loader.is_empty() && m.loader != "vanilla" {
            on_log(&format!("[note] {} client install not supported yet — installing vanilla base only.", m.loader));
        }
        install::ensure_client_installed(&st.http, &dir, &mc, on_log).await?;
    }
    let java_path = match jre::ensure_java(&st.http, 8, &st.user_data, on_log).await {
        Ok(p) => p,
        Err(_) => jre::resolve_java_path(&st.user_data),
    };
    Ok(Prepared { dir, mc: mc.clone(), modern: false, profile_id: mc, java_path })
}

// ---------- auth ----------

#[tauri::command]
pub async fn login(state: State<'_, AppState>, creds: Value) -> AppResult<Value> {
    let data: Value = http::api_json(state.inner(), "/auth/login", Method::POST, Some(creds)).await?;
    save_session(&data)?;
    Ok(data.get("user").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn register(state: State<'_, AppState>, creds: Value) -> AppResult<Value> {
    http::api_json::<Value>(state.inner(), "/auth/register", Method::POST, Some(creds.clone())).await?;
    let login_body = json!({
        "username": creds.get("username").and_then(|v| v.as_str()).unwrap_or(""),
        "password": creds.get("password").and_then(|v| v.as_str()).unwrap_or(""),
    });
    let data: Value = http::api_json(state.inner(), "/auth/login", Method::POST, Some(login_body)).await?;
    save_session(&data)?;
    Ok(data.get("user").cloned().unwrap_or(Value::Null))
}

/// IP-based password recovery — list the accounts that registered from this machine's current IP.
/// Unauthenticated (the user is locked out); the backend gates by matching the caller's IP.
#[tauri::command]
pub async fn recover_lookup(state: State<'_, AppState>) -> AppResult<Value> {
    http::api_json(state.inner(), "/auth/recover/lookup", Method::POST, None).await
}

/// Reset a chosen account's password — the backend only allows it if that account registered from this IP.
#[tauri::command]
pub async fn recover_reset(state: State<'_, AppState>, args: Value) -> AppResult<Value> {
    http::api_json(state.inner(), "/auth/recover/reset", Method::POST, Some(args)).await
}

fn save_session(data: &Value) -> AppResult<()> {
    let session = Session {
        access_token: data.get("accessToken").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        refresh_token: data.get("refreshToken").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        user: data.get("user").cloned().unwrap_or(Value::Null),
    };
    store::save(&session)
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> AppResult<bool> {
    if let Some(s) = store::load() {
        let _ = http::api_json::<Value>(
            state.inner(),
            "/auth/logout",
            Method::POST,
            Some(json!({ "refreshToken": s.refresh_token })),
        )
        .await;
    }
    store::clear();
    Ok(true)
}

#[tauri::command]
pub fn session() -> Value {
    store::load().map(|s| s.user).unwrap_or(Value::Null)
}

/// Upload a 64×64 (or 64×32) PNG skin to the backend (multipart field `file`); returns `{ skinUrl }`.
#[tauri::command]
pub async fn upload_skin(state: State<'_, AppState>, bytes: Vec<u8>) -> AppResult<Value> {
    http::authed_upload(state.inner(), "/account/skin", "file", bytes, "skin.png", "image/png").await
}

#[tauri::command]
pub async fn refresh_user(state: State<'_, AppState>) -> AppResult<Value> {
    let user: Value = http::authed_json(state.inner(), "/auth/me", Method::GET, None).await?;
    if let Some(mut s) = store::load() {
        s.user = user.clone();
        store::save(&s)?;
    }
    Ok(user)
}

// ---------- servers ----------

#[tauri::command]
pub async fn servers(state: State<'_, AppState>) -> AppResult<Value> {
    http::authed_json(state.inner(), "/servers", Method::GET, None).await
}

#[tauri::command]
pub async fn set_favorite(state: State<'_, AppState>, server_id: i64, favorite: bool) -> AppResult<Value> {
    let method = if favorite { Method::PUT } else { Method::DELETE };
    http::authed_json(state.inner(), &format!("/servers/{server_id}/favorite"), method, None).await
}

#[tauri::command]
pub async fn server_status(state: State<'_, AppState>, server_id: i64) -> AppResult<Value> {
    match http::api_json::<Value>(state.inner(), &format!("/servers/{server_id}/status"), Method::GET, None).await {
        Ok(v) => Ok(v),
        Err(_) => Ok(json!({ "running": false, "online": 0, "max": 0 })),
    }
}

#[tauri::command]
pub async fn installed(state: State<'_, AppState>, server_id: i64) -> AppResult<bool> {
    let m: ServerManifestLite =
        http::api_json(state.inner(), &format!("/servers/{server_id}/manifest"), Method::GET, None).await?;
    let dir = state.instance_dir(&m.slug);
    let mc = if m.mc_version.is_empty() { "1.7.10".to_string() } else { m.mc_version.clone() };
    if !dir.join("versions").join(&mc).join(format!("{mc}.jar")).exists() {
        return Ok(false);
    }
    if is_modern(&mc) {
        if m.loader == "forge" && !m.loader_version.is_empty() {
            return Ok(install::find_forge_profile_id(&dir, &mc).is_some());
        }
        return Ok(dir.join("versions").join(&mc).join(format!("{mc}.json")).exists());
    }
    let vjson = dir.join("version.json");
    if !vjson.exists() {
        return Ok(false);
    }
    if m.loader == "forge" {
        let txt = std::fs::read_to_string(&vjson).unwrap_or_default();
        return Ok(txt.contains("FMLTweaker"));
    }
    Ok(true)
}

#[tauri::command]
pub async fn install(app: AppHandle, state: State<'_, AppState>, server_id: i64) -> AppResult<Value> {
    if store::load().is_none() {
        return Err(AppError::msg("Not logged in"));
    }
    let m: ServerManifestLite =
        http::api_json(state.inner(), &format!("/servers/{server_id}/manifest"), Method::GET, None).await?;
    let dir = state.instance_dir(&m.slug);

    let app_p = app.clone();
    let on_progress = move |p: SyncProgress| {
        let _ = app_p.emit(
            "mc:sync-progress",
            json!({ "serverId": server_id, "phase": p.phase, "file": p.file, "done": p.done, "total": p.total }),
        );
    };
    state.cancel.lock().unwrap().remove(&server_id);
    let st = state.inner();
    let is_canceled = move || st.cancel.lock().unwrap().contains(&server_id);
    sync::sync_server(&state.http, &dir, &m.files, &on_progress, &is_canceled).await?;

    let app_l = app.clone();
    let on_log = move |line: &str| {
        let _ = app_l.emit("mc:launch-log", json!({ "serverId": server_id, "line": line }));
    };
    prepare_instance(state.inner(), &m, &on_log).await?;
    Ok(json!({ "installed": true }))
}

#[tauri::command]
pub async fn sync_server(app: AppHandle, state: State<'_, AppState>, server_id: i64) -> AppResult<Value> {
    let m: ServerManifestLite =
        http::api_json(state.inner(), &format!("/servers/{server_id}/manifest"), Method::GET, None).await?;
    let dir = state.instance_dir(&m.slug);
    let app_p = app.clone();
    let on_progress = move |p: SyncProgress| {
        let _ = app_p.emit(
            "mc:sync-progress",
            json!({ "serverId": server_id, "phase": p.phase, "file": p.file, "done": p.done, "total": p.total }),
        );
    };
    state.cancel.lock().unwrap().remove(&server_id);
    let st = state.inner();
    let is_canceled = move || st.cancel.lock().unwrap().contains(&server_id);
    let result = sync::sync_server(&state.http, &dir, &m.files, &on_progress, &is_canceled).await?;
    Ok(serde_json::to_value(result)?)
}

/// Request abort of an in-flight install/sync for this server (checked between files).
#[tauri::command]
pub fn cancel_sync(state: State<'_, AppState>, server_id: i64) {
    state.cancel.lock().unwrap().insert(server_id);
}

#[tauri::command]
pub async fn launch(app: AppHandle, state: State<'_, AppState>, server_id: i64) -> AppResult<Value> {
    let session = store::load().ok_or_else(|| AppError::msg("Not logged in"))?;
    {
        let running = state.running.lock().unwrap();
        if running.is_some() {
            return Err(AppError::msg("A server is already running — close it before launching another."));
        }
    }

    let m: ServerManifestLite =
        http::api_json(state.inner(), &format!("/servers/{server_id}/manifest"), Method::GET, None).await?;

    let app_l = app.clone();
    let on_log = move |line: &str| {
        let _ = app_l.emit("mc:launch-log", json!({ "serverId": server_id, "line": line }));
    };
    let prep = prepare_instance(state.inner(), &m, &on_log).await?;

    // Arm the join ticket AFTER the (possibly long) install, right before launch.
    let ticket: Value = http::authed_json(
        state.inner(),
        &format!("/servers/{server_id}/join-ticket"),
        Method::POST,
        None,
    )
    .await?;
    let host = ticket.get("host").and_then(|v| v.as_str()).unwrap_or("");
    // Docker binds 127.0.0.1 (IPv4); "localhost" may resolve to ::1 -> refused.
    let server = if host == "localhost" { "127.0.0.1".to_string() } else { host.to_string() };
    let port = ticket.get("port").and_then(|v| v.as_u64()).unwrap_or(25565) as u16;
    let username = session.user.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let log_cb: launch::LogCb = {
        let app = app.clone();
        Arc::new(move |line: String| {
            let _ = app.emit("mc:launch-log", json!({ "serverId": server_id, "line": line }));
        })
    };
    let exit_cb: launch::ExitCb = {
        let app = app.clone();
        Arc::new(move |code: Option<i32>| {
            if let Some(st) = app.try_state::<AppState>() {
                *st.running.lock().unwrap() = None;
            }
            let _ = app.emit("mc:launch-exit", json!({ "serverId": server_id, "code": code }));
        })
    };

    let pid = if prep.modern {
        launch::launch_modern(
            launch::ModernSpec {
                instance_dir: prep.dir,
                profile_id: prep.profile_id,
                mc_version: prep.mc,
                java_path: prep.java_path,
                username,
                max_memory_mb: max_memory_mb(state.inner()),
                server: Some(server),
                port: Some(port),
            },
            log_cb,
            exit_cb,
        )
        .await?
    } else {
        launch::launch_instance(
            launch::LegacySpec {
                instance_dir: prep.dir,
                java_path: prep.java_path,
                username,
                max_memory_mb: max_memory_mb(state.inner()),
                server: Some(server),
                port: Some(port),
            },
            log_cb,
            exit_cb,
        )
        .await?
    };

    *state.running.lock().unwrap() = Some(server_id);
    Ok(json!({ "pid": pid }))
}

// ---------- launcher settings ----------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<Value> {
    // Default game dir = the real instance root (<data_root>/.mythera).
    let default_dir = state.data_root.join(".mythera").to_string_lossy().to_string();
    let s = store::load_settings(&state.user_data, default_dir);
    Ok(serde_json::to_value(s)?)
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: store::Settings) -> AppResult<Value> {
    store::save_settings(&state.user_data, &settings)?;
    Ok(serde_json::to_value(settings)?)
}

/// Native OS folder picker for the game directory. Returns the chosen path, or None if cancelled.
#[tauri::command]
pub fn browse_game_dir() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose the Mythera game folder")
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

// ---------- self-update + version gating ----------

/// Fetch the version payload. When a session exists we send it authenticated so the backend can route
/// whitelisted users to a staged-rollout (whitelist-published) version; otherwise anonymous.
async fn fetch_version_info(st: &AppState) -> AppResult<updater::VersionInfo> {
    if store::load().is_some() {
        http::authed_json(st, "/launcher/version", Method::GET, None).await
    } else {
        http::api_json(st, "/launcher/version", Method::GET, None).await
    }
}

#[tauri::command]
pub async fn update_status(app: AppHandle, state: State<'_, AppState>) -> AppResult<Value> {
    let info = fetch_version_info(state.inner()).await?;
    let current = app.package_info().version.to_string();
    Ok(serde_json::to_value(updater::compute_status(&info, &current))?)
}

#[tauri::command]
pub async fn update_now(app: AppHandle, state: State<'_, AppState>) -> AppResult<Value> {
    use std::sync::atomic::Ordering;
    // Re-entrancy guard: a double-click / relaunch must not start a second download to the same temp dir.
    if state
        .updating
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::msg("An update is already in progress."));
    }
    let info = match fetch_version_info(state.inner()).await {
        Ok(i) => i,
        Err(e) => {
            state.updating.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let http = state.http.clone();
    let dir = std::env::temp_dir().join("mythera-update");
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let app_p = app2.clone();
        let on_progress = move |pct: u8| {
            let _ = app_p.emit("mc:update-progress", json!({ "percent": pct }));
        };
        // Clear the guard on any failure so the user can retry; on success the app exits before this.
        let clear = |h: &AppHandle| {
            if let Some(st) = h.try_state::<AppState>() {
                st.updating.store(false, Ordering::SeqCst);
            }
        };
        match updater::download_installer(&http, &info, &dir, &on_progress).await {
            Ok(path) => match updater::run_installer(&path) {
                Ok(_) => app2.exit(0),
                Err(e) => {
                    clear(&app2);
                    let _ = app2.emit("mc:update-error", json!({ "message": e.to_string() }));
                }
            },
            Err(e) => {
                clear(&app2);
                let _ = app2.emit("mc:update-error", json!({ "message": e.to_string() }));
            }
        }
    });
    Ok(json!({ "started": true }))
}
