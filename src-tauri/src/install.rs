//! Client install — port of electron/install-client.ts. Vanilla MC (version manifest, client jar,
//! libraries + natives, assets) + legacy Forge (parse install_profile.json) + modern Forge (run the
//! official installer headlessly via Java). Idempotent.

use crate::error::{AppError, AppResult};
use crate::http;
use crate::resolver::{current_os, maven_to_path, rules_allow, Rule};
use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

const VERSION_MANIFEST: &str = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const RESOURCES: &str = "https://resources.download.minecraft.net";
const FORGE_MAVEN: &str = "https://maven.minecraftforge.net/net/minecraftforge/forge";

type Log<'a> = &'a (dyn Fn(&str) + Send + Sync);

// ---------- Mojang version JSON ----------

#[derive(Debug, Deserialize)]
struct MojangDownload {
    url: Option<String>,
    path: Option<String>,
}
#[derive(Debug, Deserialize)]
struct MojangLibDownloads {
    artifact: Option<MojangDownload>,
    #[serde(default)]
    classifiers: Option<HashMap<String, MojangDownload>>,
}
#[derive(Debug, Deserialize)]
struct MojangLibrary {
    name: String,
    #[serde(default)]
    rules: Option<Vec<Rule>>,
    #[serde(default)]
    natives: Option<HashMap<String, String>>,
    #[serde(default)]
    downloads: Option<MojangLibDownloads>,
}
#[derive(Debug, Deserialize)]
struct ClientOnly {
    client: MojangDownload,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssetIndexRef {
    id: String,
    url: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionJson {
    id: String,
    downloads: ClientOnly,
    libraries: Vec<MojangLibrary>,
    asset_index: AssetIndexRef,
}
#[derive(Debug, Deserialize)]
struct ManifestEntry {
    id: String,
    url: String,
}
#[derive(Debug, Deserialize)]
struct VersionManifest {
    versions: Vec<ManifestEntry>,
}
#[derive(Debug, Deserialize)]
struct AssetObject {
    hash: String,
}
#[derive(Debug, Deserialize)]
struct AssetIndexFile {
    objects: HashMap<String, AssetObject>,
}

/// Run async tasks with bounded concurrency; first error aborts. Futures are 'static (clone the
/// reqwest client, own the data) so they can be buffered.
async fn pool<I, F, Fut>(items: Vec<I>, limit: usize, f: F) -> AppResult<()>
where
    I: Send + 'static,
    F: Fn(I) -> Fut,
    Fut: std::future::Future<Output = AppResult<()>> + Send + 'static,
{
    let mut s = stream::iter(items.into_iter().map(f)).buffer_unordered(limit);
    while let Some(r) = s.next().await {
        r?;
    }
    Ok(())
}

/// Ensure a launchable vanilla MC client is installed (version.json, client jar, libraries + natives,
/// assets). Idempotent. Vanilla only — Forge is a separate step.
pub async fn ensure_client_installed(
    http_client: &reqwest::Client,
    instance_dir: &Path,
    mc_version: &str,
    on_log: Log<'_>,
) -> AppResult<()> {
    let version_json_path = instance_dir.join("version.json");
    let client_jar = instance_dir
        .join("versions")
        .join(mc_version)
        .join(format!("{mc_version}.jar"));
    if version_json_path.exists() && client_jar.exists() {
        on_log("Client already installed.");
        return Ok(());
    }

    on_log(&format!("Resolving Minecraft {mc_version}…"));
    let manifest: VersionManifest = http::get_json(http_client, VERSION_MANIFEST).await?;
    let entry = manifest
        .versions
        .iter()
        .find(|v| v.id == mc_version)
        .ok_or_else(|| AppError::msg(format!("Unknown Minecraft version \"{mc_version}\"")))?;
    let vjson_raw = http::get_bytes(http_client, &entry.url).await?;
    let vjson: VersionJson = serde_json::from_slice(&vjson_raw)?;

    tokio::fs::create_dir_all(instance_dir).await?;
    tokio::fs::write(&version_json_path, &vjson_raw).await?;
    // Standard layout too, so a modern Forge profile's inheritsFrom can resolve the vanilla parent.
    let std_vanilla_json = instance_dir
        .join("versions")
        .join(mc_version)
        .join(format!("{mc_version}.json"));
    if let Some(p) = std_vanilla_json.parent() {
        tokio::fs::create_dir_all(p).await?;
    }
    tokio::fs::write(&std_vanilla_json, &vjson_raw).await?;

    on_log("Downloading client jar…");
    let client_url = vjson
        .downloads
        .client
        .url
        .clone()
        .ok_or_else(|| AppError::msg("no client download url"))?;
    http::download(http_client, &client_url, &client_jar).await?;

    let os = current_os();
    on_log(&format!("Downloading {} libraries…", vjson.libraries.len()));
    let libs_dir = instance_dir.join("libraries");
    let mut lib_tasks: Vec<(String, String)> = Vec::new(); // (url, relPath)
    for lib in &vjson.libraries {
        if !rules_allow(lib.rules.as_deref(), os) {
            continue;
        }
        if let Some(dl) = &lib.downloads {
            if let Some(art) = &dl.artifact {
                if let (Some(url), Some(path)) = (&art.url, &art.path) {
                    lib_tasks.push((url.clone(), path.clone()));
                }
            }
            // native classifier for this OS (${arch} -> 64)
            if let Some(nat) = &lib.natives {
                if let Some(classifier) = nat.get(os).map(|c| c.replace("${arch}", "64")) {
                    if let Some(cls) = dl.classifiers.as_ref().and_then(|c| c.get(&classifier)) {
                        if let (Some(url), Some(path)) = (&cls.url, &cls.path) {
                            lib_tasks.push((url.clone(), path.clone()));
                        }
                    }
                }
            }
        }
    }
    {
        let libs_dir = libs_dir.clone();
        let http_client = http_client.clone();
        pool(lib_tasks, 8, move |(url, rel)| {
            let dest = libs_dir.join(&rel);
            let http_client = http_client.clone();
            async move {
                if !dest.exists() {
                    http::download(&http_client, &url, &dest).await?;
                }
                Ok(())
            }
        })
        .await?;
    }

    on_log("Downloading assets…");
    let idx_path = instance_dir
        .join("assets")
        .join("indexes")
        .join(format!("{}.json", vjson.asset_index.id));
    let idx_buf = http::download(http_client, &vjson.asset_index.url, &idx_path).await?;
    let index: AssetIndexFile = serde_json::from_slice(&idx_buf)?;
    let objects: Vec<String> = index.objects.into_values().map(|o| o.hash).collect();
    on_log(&format!("Downloading {} asset objects…", objects.len()));
    {
        let assets_dir = instance_dir.join("assets").join("objects");
        let http_client = http_client.clone();
        pool(objects, 16, move |hash| {
            let sub = hash[..2].to_string();
            let dest = assets_dir.join(&sub).join(&hash);
            let http_client = http_client.clone();
            async move {
                if dest.exists() {
                    return Ok(());
                }
                let url = format!("{RESOURCES}/{sub}/{hash}");
                http::download(&http_client, &url, &dest).await?;
                Ok(())
            }
        })
        .await?;
    }

    on_log("Client install complete.");
    Ok(())
}

// ---------- Forge ----------

/// Forge maven mirror — the install_profile's legacy `url` (files.minecraftforge.net) is dead.
fn lib_base_url(lib_url: Option<&str>) -> String {
    match lib_url {
        None => "https://libraries.minecraft.net/".to_string(),
        Some(u) => {
            let base = u.replace(
                "http://files.minecraftforge.net/maven/",
                "https://maven.minecraftforge.net/",
            );
            if base.ends_with('/') {
                base
            } else {
                format!("{base}/")
            }
        }
    }
}

/// Fetch the Forge installer jar bytes, trying the legacy doubled-suffix coord first.
async fn fetch_forge_installer(
    http_client: &reqwest::Client,
    mc_version: &str,
    forge_version: &str,
) -> AppResult<Vec<u8>> {
    let candidates = [
        format!("{mc_version}-{forge_version}-{mc_version}"),
        format!("{mc_version}-{forge_version}"),
    ];
    for ver in candidates {
        let url = format!("{FORGE_MAVEN}/{ver}/forge-{ver}-installer.jar");
        let res = http_client.get(&url).send().await?;
        if res.status().is_success() {
            return Ok(res.bytes().await?.to_vec());
        }
    }
    Err(AppError::msg(format!(
        "Forge installer not found for {mc_version}-{forge_version}"
    )))
}

/// Run a process to completion, streaming stdout+stderr to on_log.
async fn run_process(exe: &str, args: &[String], cwd: &Path, on_log: Log<'_>) -> AppResult<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Windows: java.exe is a console app — without this it pops a black terminal window the user can
    // close mid-install (breaking the Forge/Java setup). CREATE_NO_WINDOW runs it fully in the background.
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::msg("no stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::msg("no stderr"))?;
    let mut out = BufReader::new(stdout).lines();
    let mut err = BufReader::new(stderr).lines();
    let read_out = async {
        while let Ok(Some(line)) = out.next_line().await {
            on_log(line.trim());
        }
    };
    let read_err = async {
        while let Ok(Some(line)) = err.next_line().await {
            on_log(line.trim());
        }
    };
    let (_, _, status) = tokio::join!(read_out, read_err, child.wait());
    let status = status?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::msg(format!(
            "Forge installer exited with code {:?}",
            status.code()
        )))
    }
}

/// The forge profile id the installer wrote under versions/ (the one inheriting from the vanilla mc).
pub fn find_forge_profile_id(instance_dir: &Path, mc_version: &str) -> Option<String> {
    let versions = instance_dir.join("versions");
    let entries = std::fs::read_dir(&versions).ok()?;
    let mut name_match: Option<String> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == mc_version {
            continue;
        }
        let json_path = versions.join(&name).join(format!("{name}.json"));
        if let Ok(txt) = std::fs::read_to_string(&json_path) {
            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&txt) {
                if j.get("inheritsFrom").and_then(|v| v.as_str()) == Some(mc_version) {
                    return Some(name); // the reliable signal
                }
            }
        }
        if name.to_lowercase().contains("forge") && name_match.is_none() {
            name_match = Some(name);
        }
    }
    name_match
}

/// Modern Forge (1.13+) client install: run the OFFICIAL installer headlessly. Returns the forge id.
pub async fn ensure_modern_forge_installed(
    http_client: &reqwest::Client,
    instance_dir: &Path,
    mc_version: &str,
    forge_version: &str,
    java_console_path: &str,
    on_log: Log<'_>,
) -> AppResult<String> {
    if let Some(existing) = find_forge_profile_id(instance_dir, mc_version) {
        if instance_dir
            .join("versions")
            .join(&existing)
            .join(format!("{existing}.json"))
            .exists()
        {
            on_log("Forge already installed.");
            return Ok(existing);
        }
    }

    on_log(&format!("Downloading Forge {mc_version}-{forge_version} installer…"));
    let buffer = fetch_forge_installer(http_client, mc_version, forge_version).await?;
    tokio::fs::create_dir_all(instance_dir).await?;
    // The installer refuses to run without a launcher_profiles.json present (don't clobber an existing one).
    let profiles_file = instance_dir.join("launcher_profiles.json");
    if !profiles_file.exists() {
        tokio::fs::write(
            &profiles_file,
            serde_json::to_vec(&serde_json::json!({ "profiles": {}, "settings": {}, "version": 3 }))?,
        )
        .await?;
    }
    let installer_path = instance_dir.join("forge-installer.jar");
    tokio::fs::write(&installer_path, &buffer).await?;

    on_log("Running Forge installer (downloads + patches; this can take a minute)…");
    let args = vec![
        "-jar".to_string(),
        installer_path.to_string_lossy().to_string(),
        "--installClient".to_string(),
        instance_dir.to_string_lossy().to_string(),
    ];
    run_process(java_console_path, &args, instance_dir, on_log).await?;
    let _ = tokio::fs::remove_file(&installer_path).await;

    let forge_id = find_forge_profile_id(instance_dir, mc_version)
        .ok_or_else(|| AppError::msg("Forge profile not found after install (installer may have failed)"))?;
    on_log(&format!("Forge {forge_id} installed."));
    Ok(forge_id)
}

// ---------- legacy (1.7.10) Forge ----------

#[derive(Debug, Deserialize)]
struct InstallSection {
    path: Option<String>,
    #[serde(rename = "filePath")]
    file_path: Option<String>,
    minecraft: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
struct VersionInfoLib {
    name: String,
    #[serde(default)]
    url: Option<String>,
}
#[derive(Debug, Deserialize)]
struct VersionInfoSection {
    #[serde(default)]
    libraries: Option<Vec<VersionInfoLib>>,
}
#[derive(Debug, Deserialize)]
struct InstallProfile {
    install: Option<InstallSection>,
    #[serde(rename = "versionInfo")]
    version_info: Option<VersionInfoSection>,
}

fn read_zip_entry(bytes: &[u8], name: &str) -> AppResult<Option<Vec<u8>>> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)?;
    // Early-return out of the match so the borrowed ZipFile isn't the block's trailing temporary
    // (which would keep `archive` borrowed past its drop — E0597).
    let mut f = match archive.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(AppError::Zip(e)),
    };
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(Some(buf))
}

/// Install the Forge CLIENT for 1.7.10 by parsing the installer's install_profile.json (no GUI).
pub async fn ensure_forge_installed(
    http_client: &reqwest::Client,
    instance_dir: &Path,
    mc_version: &str,
    forge_version: &str,
    on_log: Log<'_>,
) -> AppResult<()> {
    ensure_client_installed(http_client, instance_dir, mc_version, on_log).await?; // vanilla base

    let version_json_path = instance_dir.join("version.json");
    // version.json is written LAST, so its presence + Forge marker means a prior install finished.
    if version_json_path.exists() {
        if let Ok(existing) = tokio::fs::read_to_string(&version_json_path).await {
            if existing.contains("FMLTweaker") {
                on_log("Forge already installed.");
                return Ok(());
            }
        }
    }

    on_log(&format!("Downloading Forge {mc_version}-{forge_version} installer…"));
    let installer = fetch_forge_installer(http_client, mc_version, forge_version).await?;
    let profile_bytes = read_zip_entry(&installer, "install_profile.json")?
        .ok_or_else(|| AppError::msg("install_profile.json not found in Forge installer"))?;
    let profile: InstallProfile = serde_json::from_slice(&profile_bytes)?;
    // Keep the raw value too, so we can write versionInfo back out as version.json with `jar` set.
    let profile_raw: serde_json::Value = serde_json::from_slice(&profile_bytes)?;

    let install = profile.install;
    let version_info = profile.version_info;
    // Modern Forge (1.13+) ships a different installer (spec/processors). Fail clearly.
    let (install, version_info) = match (install, version_info) {
        (Some(i), Some(v))
            if i.path.is_some() && i.file_path.is_some() && v.libraries.is_some() =>
        {
            (i, v)
        }
        _ => {
            return Err(AppError::msg(format!(
                "Forge {mc_version} uses the modern (1.13+) installer format, which the launcher can't \
                 auto-install yet. Legacy Forge (1.7.10–1.12.2) and vanilla servers work."
            )));
        }
    };
    let install_path = install.path.clone().unwrap();
    let install_file_path = install.file_path.clone().unwrap();
    let libs = version_info.libraries.clone().unwrap();

    // Extract the bundled forge universal jar to libraries/<maven path of install.path>.
    on_log("Installing Forge universal jar…");
    let universal_rel = maven_to_path(&install_path, None);
    let universal_path = instance_dir.join("libraries").join(&universal_rel);
    let uni_bytes = read_zip_entry(&installer, &install_file_path)?
        .ok_or_else(|| AppError::msg(format!("Forge universal jar ({install_file_path}) not in installer")))?;
    if let Some(p) = universal_path.parent() {
        tokio::fs::create_dir_all(p).await?;
    }
    tokio::fs::write(&universal_path, &uni_bytes).await?;

    // Download Forge's libraries (skip the universal — just placed — and anything already present).
    let to_dl: Vec<VersionInfoLib> = libs.into_iter().filter(|l| l.name != install_path).collect();
    on_log(&format!("Downloading {} Forge libraries…", to_dl.len()));
    {
        let libs_dir = instance_dir.join("libraries");
        let http_client = http_client.clone();
        // Forge lib failures are non-fatal (warn) like the TS; collect names for logging is omitted.
        let mut tasks = Vec::new();
        for lib in to_dl {
            let rel = maven_to_path(&lib.name, None);
            let dest = libs_dir.join(&rel);
            let url = format!("{}{}", lib_base_url(lib.url.as_deref()), rel);
            tasks.push((url, dest, lib.name));
        }
        // Bounded concurrency 6; errors swallowed (best-effort), matching the TS try/catch warn.
        let http_client2 = http_client.clone();
        let mut s = stream::iter(tasks.into_iter().map(move |(url, dest, _name)| {
            let http_client = http_client2.clone();
            async move {
                if !dest.exists() {
                    let _ = http::download(&http_client, &url, &dest).await;
                }
            }
        }))
        .buffer_unordered(6);
        while s.next().await.is_some() {}
    }

    // versionInfo becomes version.json, with `jar` pinned to the vanilla mc id so the base client jar
    // stays on the classpath (1.7.10 Forge has no jar/inheritsFrom).
    let mut version_info_value = profile_raw
        .get("versionInfo")
        .cloned()
        .ok_or_else(|| AppError::msg("versionInfo missing"))?;
    let jar_id = install.minecraft.clone().unwrap_or_else(|| mc_version.to_string());
    if let Some(obj) = version_info_value.as_object_mut() {
        obj.insert("jar".to_string(), serde_json::Value::String(jar_id));
    }
    tokio::fs::write(&version_json_path, serde_json::to_vec(&version_info_value)?).await?;
    on_log("Forge client install complete.");
    Ok(())
}
