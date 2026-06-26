//! Launch a prepared instance — ports electron/launch.ts (legacy 1.7.10) + launch-modern.ts (1.13+).
//! Spawns Java, streams stdout/stderr to `on_log`, and fires `on_exit` with the exit code. The base
//! game/forge/library files must already be present (installed by `install` + brought down by sync).

use crate::error::{AppError, AppResult};
use crate::launch_args::{build_launch_args, LaunchOptions, FORGE_1710_MAIN_CLASS};
use crate::offline_uuid::{normalize_username, offline_uuid};
use crate::resolver::{
    assets_need_virtual, classpath_separator, current_os, maven_to_path, parse_maven,
    parse_version_json, resolve_libraries, rules_allow, Rule,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub type LogCb = Arc<dyn Fn(String) + Send + Sync>;
pub type ExitCb = Arc<dyn Fn(Option<i32>) + Send + Sync>;

pub struct LegacySpec {
    pub instance_dir: PathBuf,
    pub java_path: String,
    pub username: String,
    pub max_memory_mb: u32,
    pub server: Option<String>,
    pub port: Option<u16>,
}

pub struct ModernSpec {
    pub instance_dir: PathBuf,
    pub profile_id: String,
    pub mc_version: String,
    pub java_path: String,
    pub username: String,
    pub max_memory_mb: u32,
    pub server: Option<String>,
    pub port: Option<u16>,
}

/// Extract native jars into a flat dir (skip directories + META-INF), overwriting. Blocking.
fn extract_natives(jars: &[PathBuf], natives_dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(natives_dir)?;
    for jar in jars {
        if !jar.exists() {
            continue;
        }
        let file = std::fs::File::open(jar)?;
        let mut archive = zip::ZipArchive::new(file)?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            if name.starts_with("META-INF/") {
                continue;
            }
            let base = name.rsplit('/').next().unwrap_or(&name).to_string();
            if base.is_empty() {
                continue;
            }
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            std::fs::write(natives_dir.join(base), buf)?;
        }
    }
    Ok(())
}

// ---------- legacy 1.7.10 ----------

pub async fn launch_instance(o: LegacySpec, on_log: LogCb, on_exit: ExitCb) -> AppResult<u32> {
    let dir = o.instance_dir.clone();
    let version_json_path = dir.join("version.json");
    if !version_json_path.exists() {
        return Err(AppError::msg(
            "Game client not installed for this server yet (base client/Forge files missing).",
        ));
    }
    let raw: Value = serde_json::from_slice(&std::fs::read(&version_json_path)?)?;
    let v = parse_version_json(&raw);
    let os = current_os();

    let libs_dir = dir.join("libraries");
    let (lib_rel, native_rel) = resolve_libraries(&v.libraries, os);
    let mut classpath: Vec<String> = lib_rel
        .iter()
        .map(|p| libs_dir.join(p).to_string_lossy().to_string())
        .collect();
    classpath.push(
        dir.join("versions")
            .join(&v.vanilla_id)
            .join(format!("{}.jar", v.vanilla_id))
            .to_string_lossy()
            .to_string(),
    );

    let natives_dir = dir.join("natives");
    let native_jars: Vec<PathBuf> = native_rel.iter().map(|r| libs_dir.join(r)).collect();
    for j in &native_jars {
        if !j.exists() {
            on_log(format!("[warn] native jar missing: {}", j.display()));
        }
    }
    extract_natives(&native_jars, &natives_dir)?;

    // assets: only materialize a virtual tree when the index declares it.
    let mut assets_dir = dir.join("assets");
    let idx_path = assets_dir.join("indexes").join(format!("{}.json", v.asset_index));
    if idx_path.exists() {
        if let Ok(txt) = std::fs::read_to_string(&idx_path) {
            if let Ok(idx) = serde_json::from_str::<Value>(&txt) {
                if assets_need_virtual(&idx) {
                    assets_dir = materialize_virtual(&assets_dir, &idx, &v.asset_index, &on_log);
                }
            }
        }
    } else {
        on_log(format!("[warn] asset index {}.json not found under assets/indexes", v.asset_index));
    }

    let username = normalize_username(&o.username);
    let uuid = offline_uuid(&username);
    let main_class = if v.main_class.is_empty() {
        FORGE_1710_MAIN_CLASS.to_string()
    } else {
        v.main_class.clone()
    };

    let args = build_launch_args(&LaunchOptions {
        max_memory_mb: o.max_memory_mb,
        natives_dir: natives_dir.to_string_lossy().to_string(),
        classpath,
        main_class,
        tweak_class: v.tweak_class.clone(),
        username: username.clone(),
        uuid,
        access_token: None,
        version: v.id.clone(),
        game_dir: dir.to_string_lossy().to_string(),
        assets_dir: assets_dir.to_string_lossy().to_string(),
        asset_index: v.asset_index.clone(),
        user_type: None,
        user_properties: None,
        server: o.server.clone(),
        port: o.port,
        extra_jvm_args: None,
        os: os.to_string(),
    });

    on_log(format!("[launch] java={} cp={} natives={}", o.java_path, args.len(), native_rel.len()));
    spawn_and_stream(&o.java_path, args, dir, None, on_log, on_exit).await
}

fn materialize_virtual(assets_dir: &Path, idx: &Value, asset_index_id: &str, on_log: &LogCb) -> PathBuf {
    let virtual_dir = assets_dir.join("virtual").join(asset_index_id);
    let objects = idx.get("objects").and_then(|o| o.as_object());
    let mut copied = 0u32;
    if let Some(objs) = objects {
        for (rel, meta) in objs {
            let hash = match meta.get("hash").and_then(|h| h.as_str()) {
                Some(h) => h,
                None => continue,
            };
            let src = assets_dir.join("objects").join(&hash[..2]).join(hash);
            let dest = virtual_dir.join(rel);
            if !src.exists() || dest.exists() {
                continue;
            }
            if let Some(p) = dest.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            if std::fs::copy(&src, &dest).is_ok() {
                copied += 1;
            }
        }
    }
    on_log(format!("[assets] materialized {copied} virtual asset(s)"));
    virtual_dir
}

// ---------- modern 1.13+ ----------

#[derive(Debug, Deserialize, Clone)]
struct ModernArtifact {
    path: Option<String>,
}
#[derive(Debug, Deserialize, Clone)]
struct ModernLibDownloads {
    artifact: Option<ModernArtifact>,
    #[serde(default)]
    classifiers: Option<HashMap<String, ModernArtifact>>,
}
#[derive(Debug, Deserialize, Clone)]
struct ModernLib {
    name: String,
    #[serde(default)]
    rules: Option<Vec<Rule>>,
    #[serde(default)]
    natives: Option<HashMap<String, String>>,
    #[serde(default)]
    downloads: Option<ModernLibDownloads>,
}
#[derive(Debug, Deserialize, Clone)]
struct AssetIndexId {
    id: Option<String>,
}
#[derive(Debug, Deserialize, Clone)]
struct ModernArguments {
    #[serde(default)]
    jvm: Option<Vec<Value>>,
    #[serde(default)]
    game: Option<Vec<Value>>,
}
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModernVersion {
    id: String,
    #[serde(default)]
    inherits_from: Option<String>,
    #[serde(default)]
    main_class: Option<String>,
    #[serde(default)]
    jar: Option<String>,
    #[serde(default)]
    asset_index: Option<AssetIndexId>,
    #[serde(default)]
    assets: Option<String>,
    #[serde(default)]
    arguments: Option<ModernArguments>,
    #[serde(default)]
    libraries: Option<Vec<ModernLib>>,
}

struct Merged {
    main_class: String,
    jar: String,
    asset_index_id: Option<String>,
    assets: Option<String>,
    jvm: Vec<Value>,
    game: Vec<Value>,
    libraries: Vec<ModernLib>,
}

/// Load a version profile, merging its inheritsFrom parent (vanilla) for modern Forge.
fn load_profile(instance_dir: &Path, id: &str) -> AppResult<Merged> {
    let path = instance_dir.join("versions").join(id).join(format!("{id}.json"));
    let raw: ModernVersion = serde_json::from_slice(&std::fs::read(&path)?)?;
    let raw_args = raw.arguments.clone().unwrap_or(ModernArguments { jvm: None, game: None });
    match raw.inherits_from.clone() {
        None => Ok(Merged {
            main_class: raw.main_class.clone().unwrap_or_default(),
            jar: raw.jar.clone().unwrap_or_else(|| raw.id.clone()),
            asset_index_id: raw.asset_index.and_then(|a| a.id),
            assets: raw.assets.clone(),
            jvm: raw_args.jvm.unwrap_or_default(),
            game: raw_args.game.unwrap_or_default(),
            libraries: raw.libraries.unwrap_or_default(),
        }),
        Some(parent_id) => {
            let parent = load_profile(instance_dir, &parent_id)?;
            let mut jvm = parent.jvm.clone();
            jvm.extend(raw_args.jvm.unwrap_or_default());
            let mut game = parent.game.clone();
            game.extend(raw_args.game.unwrap_or_default());
            let mut libraries = parent.libraries.clone();
            libraries.extend(raw.libraries.unwrap_or_default());
            Ok(Merged {
                main_class: raw.main_class.clone().unwrap_or(parent.main_class),
                jar: raw.jar.clone().unwrap_or(parent.jar),
                asset_index_id: raw.asset_index.and_then(|a| a.id).or(parent.asset_index_id),
                assets: raw.assets.clone().or(parent.assets),
                jvm,
                game,
                libraries,
            })
        }
    }
}

/// A rule item matches only when its OS rule fits and it requires no launcher "features".
fn item_allowed(rules: Option<&Vec<Value>>, os: &str) -> bool {
    let rules = match rules {
        None => return true,
        Some(r) if r.is_empty() => return true,
        Some(r) => r,
    };
    let mut allowed = false;
    for r in rules {
        if r.get("features").is_some() {
            continue; // demo / custom-resolution etc. — not provided
        }
        if let Some(name) = r.get("os").and_then(|o| o.get("name")).and_then(|n| n.as_str()) {
            if name != os {
                continue;
            }
        }
        allowed = r.get("action").and_then(|a| a.as_str()) == Some("allow");
    }
    allowed
}

fn flatten(items: &[Value], os: &str) -> Vec<String> {
    let mut out = Vec::new();
    for it in items {
        if let Some(s) = it.as_str() {
            out.push(s.to_string());
        } else if it.is_object() {
            let rules = it.get("rules").and_then(|r| r.as_array()).cloned();
            if item_allowed(rules.as_ref(), os) {
                match it.get("value") {
                    Some(Value::String(s)) => out.push(s.clone()),
                    Some(Value::Array(arr)) => {
                        for v in arr {
                            if let Some(s) = v.as_str() {
                                out.push(s.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

/// Classpath (absolute lib jars + the vanilla client jar), deduped by group:artifact:classifier
/// (last wins, first position preserved). Paths taken from downloads.*.path, falling back to maven.
fn build_classpath(instance_dir: &Path, libs: &[ModernLib], jar_id: &str, os: &str) -> (Vec<String>, Vec<String>) {
    let lib_dir = instance_dir.join("libraries");
    let mut order: Vec<String> = Vec::new();
    let mut values: HashMap<String, String> = HashMap::new();
    let mut natives: Vec<String> = Vec::new();

    for lib in libs {
        if !rules_allow(lib.rules.as_deref(), os) {
            continue;
        }
        let native_classifier = lib.natives.as_ref().and_then(|m| m.get(os)).map(|c| c.replace("${arch}", "64"));
        if let Some(nc) = native_classifier {
            let rel = lib
                .downloads
                .as_ref()
                .and_then(|d| d.classifiers.as_ref())
                .and_then(|c| c.get(&nc))
                .and_then(|a| a.path.clone())
                .unwrap_or_else(|| maven_to_path(&lib.name, Some(&nc)));
            natives.push(lib_dir.join(rel).to_string_lossy().to_string());
        } else {
            let p = parse_maven(&lib.name);
            let key = format!("{}:{}:{}", p.group, p.artifact, p.classifier.clone().unwrap_or_default());
            let rel = lib
                .downloads
                .as_ref()
                .and_then(|d| d.artifact.as_ref())
                .and_then(|a| a.path.clone())
                .unwrap_or_else(|| maven_to_path(&lib.name, None));
            let abs = lib_dir.join(rel).to_string_lossy().to_string();
            if !values.contains_key(&key) {
                order.push(key.clone());
            }
            values.insert(key, abs);
        }
    }
    let mut cp: Vec<String> = order.into_iter().map(|k| values.remove(&k).unwrap_or_default()).collect();
    cp.push(
        instance_dir
            .join("versions")
            .join(jar_id)
            .join(format!("{jar_id}.jar"))
            .to_string_lossy()
            .to_string(),
    );
    (cp, natives)
}

pub async fn launch_modern(o: ModernSpec, on_log: LogCb, on_exit: ExitCb) -> AppResult<u32> {
    let os = current_os();
    let sep = classpath_separator(os);
    let profile = load_profile(&o.instance_dir, &o.profile_id)?;

    // The client jar on -cp must be named <profileId>.jar (matches Forge's -DignoreList ${version_name}.jar).
    let vanilla_jar_id = if profile.jar.is_empty() { o.mc_version.clone() } else { profile.jar.clone() };
    let launch_jar = o.instance_dir.join("versions").join(&o.profile_id).join(format!("{}.jar", o.profile_id));
    if !launch_jar.exists() {
        let src = o
            .instance_dir
            .join("versions")
            .join(&vanilla_jar_id)
            .join(format!("{vanilla_jar_id}.jar"));
        if src.exists() {
            if let Some(p) = launch_jar.parent() {
                tokio::fs::create_dir_all(p).await?;
            }
            tokio::fs::copy(&src, &launch_jar).await?;
        }
    }

    let (cp, natives) = build_classpath(&o.instance_dir, &profile.libraries, &o.profile_id, os);
    let natives_dir = o.instance_dir.join("natives").join(&o.profile_id);
    let native_jars: Vec<PathBuf> = natives.iter().map(PathBuf::from).collect();
    extract_natives(&native_jars, &natives_dir)?;

    let username = normalize_username(&o.username);
    let asset_index_id = profile
        .asset_index_id
        .clone()
        .or_else(|| profile.assets.clone())
        .unwrap_or_else(|| o.mc_version.clone());

    let mut vars: HashMap<String, String> = HashMap::new();
    vars.insert("auth_player_name".into(), username.clone());
    vars.insert("version_name".into(), o.profile_id.clone());
    vars.insert("game_directory".into(), o.instance_dir.to_string_lossy().to_string());
    vars.insert("assets_root".into(), o.instance_dir.join("assets").to_string_lossy().to_string());
    vars.insert("assets_index_name".into(), asset_index_id.clone());
    vars.insert("auth_uuid".into(), offline_uuid(&username));
    vars.insert("auth_access_token".into(), "0".into());
    vars.insert("clientid".into(), "".into());
    vars.insert("auth_xuid".into(), "".into());
    vars.insert("user_type".into(), "msa".into());
    vars.insert("version_type".into(), "release".into());
    vars.insert("natives_directory".into(), natives_dir.to_string_lossy().to_string());
    vars.insert("launcher_name".into(), "mythera".into());
    vars.insert("launcher_version".into(), "1.0".into());
    vars.insert("classpath".into(), cp.join(sep));
    vars.insert("classpath_separator".into(), sep.to_string());
    vars.insert("library_directory".into(), o.instance_dir.join("libraries").to_string_lossy().to_string());
    vars.insert("user_properties".into(), "{}".into());

    let sub = |s: &str| -> String {
        let mut result = String::with_capacity(s.len());
        let bytes = s.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
                if let Some(end) = s[i + 2..].find('}') {
                    let key = &s[i + 2..i + 2 + end];
                    if let Some(val) = vars.get(key) {
                        result.push_str(val);
                    } else {
                        result.push_str(&s[i..i + 2 + end + 1]);
                    }
                    i += 2 + end + 1;
                    continue;
                }
            }
            result.push(bytes[i] as char);
            i += 1;
        }
        result
    };

    let mem = vec![
        format!("-Xms{}M", o.max_memory_mb.min(512)),
        format!("-Xmx{}M", o.max_memory_mb),
    ];
    let jvm: Vec<String> = flatten(&profile.jvm, os).iter().map(|s| sub(s)).collect();
    let game: Vec<String> = flatten(&profile.game, os).iter().map(|s| sub(s)).collect();

    // Direct-connect: 1.20+ replaced --server/--port with --quickPlayMultiplayer "host:port".
    let mut connect: Vec<String> = Vec::new();
    if let Some(server) = &o.server {
        let minor: u32 = o.mc_version.split('.').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let port = o.port.unwrap_or(25565);
        if minor >= 20 {
            connect = vec!["--quickPlayMultiplayer".into(), format!("{server}:{port}")];
        } else {
            connect = vec!["--server".into(), server.clone(), "--port".into(), port.to_string()];
        }
    }

    let mut args: Vec<String> = Vec::new();
    args.extend(mem);
    args.extend(jvm);
    args.push(profile.main_class.clone());
    args.extend(game);
    args.extend(connect);

    on_log(format!("Launching {} (modern)…", o.profile_id));
    let log_path = o.instance_dir.join("launcher-launch.log");
    spawn_and_stream(&o.java_path, args, o.instance_dir.clone(), Some(log_path), on_log, on_exit).await
}

// ---------- shared spawn + stream ----------

async fn spawn_and_stream(
    java: &str,
    args: Vec<String>,
    cwd: PathBuf,
    log_file: Option<PathBuf>,
    on_log: LogCb,
    on_exit: ExitCb,
) -> AppResult<u32> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    // Optional launch log for crash diagnosis (full command + game output).
    let file: Arc<Mutex<Option<std::fs::File>>> = Arc::new(Mutex::new(match &log_file {
        Some(p) => {
            let mut f = std::fs::File::create(p)?;
            let _ = writeln!(f, "CMD: {java}\n{}\n\n--- game output ---", args.iter().map(|a| format!("  {a}")).collect::<Vec<_>>().join("\n"));
            Some(f)
        }
        None => None,
    }));

    let mut cmd = Command::new(java);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Windows: never flash a console window for the game process either (javaw is GUI, but be explicit).
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn()?;
    let pid = child.id().unwrap_or(0);
    let stdout = child.stdout.take().ok_or_else(|| AppError::msg("no stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::msg("no stderr"))?;

    let reader = |stream: tokio::process::ChildStdout, log: LogCb, file: Arc<Mutex<Option<std::fs::File>>>| async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(mut g) = file.lock() {
                if let Some(f) = g.as_mut() {
                    let _ = writeln!(f, "{line}");
                }
            }
            log(line);
        }
    };
    // stdout reader
    tokio::spawn(reader(stdout, on_log.clone(), file.clone()));
    // stderr reader (same closure shape, different stream type -> separate task)
    {
        let on_log = on_log.clone();
        let file = file.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut g) = file.lock() {
                    if let Some(f) = g.as_mut() {
                        let _ = writeln!(f, "{line}");
                    }
                }
                on_log(line);
            }
        });
    }

    // waiter
    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.ok().and_then(|s| s.code());
        if let Ok(mut g) = file.lock() {
            if let Some(f) = g.as_mut() {
                let _ = writeln!(f, "\n--- exited with code {code:?} ---");
            }
        }
        on_exit(code);
    });

    Ok(pid)
}
