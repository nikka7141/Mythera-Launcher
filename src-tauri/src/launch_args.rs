//! Builds the full argv (after the `java` executable) for launching Minecraft 1.7.10 + Forge
//! with an offline account. Pure -> unit-testable; the exact class/arg strings are pinned by the
//! launch-contract review (1.7.10 uses launchwrapper + the cpw.mods.fml tweak class).
//!
//! Ported faithfully from `electron/launch-args.ts`. The TS used NodeJS.Platform
//! ("win32"/"darwin"/"linux"); here the OS is a normalized `"windows" | "osx" | "linux"` string
//! (mirroring the rest of the Tauri port). The only platform-dependent behavior:
//!   - classpath separator: ";" on windows, ":" otherwise.
//!   - "-XstartOnFirstThread": macOS (os == "osx") only — LWJGL/AWT must own the first thread.

/// Pinned constants for MC 1.7.10 + Forge (verified by the launch-contract review).
pub const FORGE_1710_MAIN_CLASS: &str = "net.minecraft.launchwrapper.Launch";
pub const FORGE_1710_TWEAK_CLASS: &str = "cpw.mods.fml.common.launcher.FMLTweaker";
pub const ASSET_INDEX_1710: &str = "1.7.10";

/// Returns the current OS as `"windows" | "osx" | "linux"`, replacing NodeJS.Platform.
/// Non win/mac targets fall back to "linux" (matches the TS `else` branch behavior).
pub fn current_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

/// Non-empty placeholder offline access token; some 1.7.10 mods assume a token-length string,
/// so this is 32 chars of "0" rather than a bare "0".
pub fn offline_access_token() -> String {
    "0".repeat(32)
}

/// Classpath separator: ";" on windows, ":" everywhere else.
/// (Ports `version-resolver.classpathSeparator`: `platform === 'win32' ? ';' : ':'`.)
fn classpath_separator(os: &str) -> &'static str {
    if os == "windows" {
        ";"
    } else {
        ":"
    }
}

/// Launch options for `build_launch_args`. Field names mirror the TS `LaunchOptions` interface
/// (camelCase over the JSON boundary). `os` is "windows"/"osx"/"linux" (replaces NodeJS.Platform).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOptions {
    pub max_memory_mb: u32,
    pub natives_dir: String,
    /// absolute jar paths (libraries + version jar)
    pub classpath: Vec<String>,
    /// forge: net.minecraft.launchwrapper.Launch · vanilla: net.minecraft.client.main.Main
    pub main_class: String,
    /// forge: cpw.mods.fml.common.launcher.FMLTweaker · vanilla: none
    pub tweak_class: Option<String>,
    /// normalized (lower-cased) so the client UUID == backend mcUuid
    pub username: String,
    /// offline uuid
    pub uuid: String,
    /// any non-empty; "0"*32 for offline
    pub access_token: Option<String>,
    /// version_name, e.g. "1.7.10-Forge10.13.4.1614-1.7.10"
    pub version: String,
    pub game_dir: String,
    pub assets_dir: String,
    /// "1.7.10"
    pub asset_index: String,
    /// "legacy"
    pub user_type: Option<String>,
    /// "{}"
    pub user_properties: Option<String>,
    /// direct-connect host
    pub server: Option<String>,
    pub port: Option<u16>,
    pub extra_jvm_args: Option<Vec<String>>,
    /// "windows" | "osx" | "linux"
    pub os: String,
}

/// Builds the full launch argv (after the `java` executable).
///
/// Order is: [jvm args] mainClass [game args] [tweak] [connect]. The main class always lands
/// after `-cp` (the spec asserts `indexOf(mainClass) > indexOf('-cp')`).
pub fn build_launch_args(o: &LaunchOptions) -> Vec<String> {
    let sep = classpath_separator(&o.os);

    let mut jvm: Vec<String> = vec![
        // Xms = min(512, maxMemoryMb).
        format!("-Xms{}M", o.max_memory_mb.min(512)),
        format!("-Xmx{}M", o.max_memory_mb),
        format!("-Djava.library.path={}", o.natives_dir),
        format!("-Dorg.lwjgl.librarypath={}", o.natives_dir),
        format!("-Dnet.java.games.input.librarypath={}", o.natives_dir),
        "-Dminecraft.launcher.brand=mythera".to_string(),
        // FML props (1.7.10): tolerate a repackaged/offline client. ignoreInvalidMinecraftCertificates
        // relaxes the jar-signing check — acceptable for an offline launcher, not a vanilla-online one.
        "-Dfml.ignoreInvalidMinecraftCertificates=true".to_string(),
        "-Dfml.ignorePatchDiscrepancies=true".to_string(),
    ];

    // macOS LWJGL/AWT must own the first thread.
    if o.os == "osx" {
        jvm.push("-XstartOnFirstThread".to_string());
    }

    if let Some(extra) = &o.extra_jvm_args {
        jvm.extend(extra.iter().cloned());
    }

    jvm.push("-cp".to_string());
    jvm.push(o.classpath.join(sep));

    let game: Vec<String> = vec![
        "--username".to_string(),
        o.username.clone(),
        "--version".to_string(),
        o.version.clone(),
        "--gameDir".to_string(),
        o.game_dir.clone(),
        "--assetsDir".to_string(),
        o.assets_dir.clone(),
        "--assetIndex".to_string(),
        o.asset_index.clone(),
        "--uuid".to_string(),
        o.uuid.clone(),
        "--accessToken".to_string(),
        o.access_token.clone().unwrap_or_else(offline_access_token),
        "--userProperties".to_string(),
        o.user_properties.clone().unwrap_or_else(|| "{}".to_string()),
        "--userType".to_string(),
        o.user_type.clone().unwrap_or_else(|| "legacy".to_string()),
    ];

    let mut args: Vec<String> = Vec::new();
    args.extend(jvm);
    args.push(o.main_class.clone());
    args.extend(game);

    // Forge/Fabric add a tweak class; vanilla has none.
    if let Some(tweak) = &o.tweak_class {
        args.push("--tweakClass".to_string());
        args.push(tweak.clone());
    }

    // Direct-connect: default port 25565 if a server is given without an explicit port.
    if let Some(server) = &o.server {
        args.push("--server".to_string());
        args.push(server.clone());
        args.push("--port".to_string());
        args.push(o.port.unwrap_or(25565).to_string());
    }

    args
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors the `base` LaunchOptions from launch-args.spec.ts (platform: 'win32' -> os: "windows").
    fn base() -> LaunchOptions {
        LaunchOptions {
            max_memory_mb: 2048,
            natives_dir: "/n".to_string(),
            classpath: vec!["/a.jar".to_string(), "/b.jar".to_string()],
            main_class: FORGE_1710_MAIN_CLASS.to_string(),
            tweak_class: Some(FORGE_1710_TWEAK_CLASS.to_string()),
            username: "player".to_string(),
            uuid: "u".to_string(),
            access_token: None,
            version: "1.7.10".to_string(),
            game_dir: "/g".to_string(),
            assets_dir: "/as".to_string(),
            asset_index: "1.7.10".to_string(),
            user_type: None,
            user_properties: None,
            server: None,
            port: None,
            extra_jvm_args: None,
            os: "windows".to_string(),
        }
    }

    fn index_of(args: &[String], v: &str) -> Option<usize> {
        args.iter().position(|x| x == v)
    }

    #[test]
    fn includes_jvm_args_main_class_after_cp_and_forge_tweak() {
        let a = build_launch_args(&base());
        assert!(a.iter().any(|x| x == "-Xmx2048M"));
        assert!(a.iter().any(|x| x == "-Xms512M"));
        assert!(a.iter().any(|x| x == "-Djava.library.path=/n"));

        let cp_idx = index_of(&a, "-cp").unwrap();
        assert_eq!(a[cp_idx + 1], "/a.jar;/b.jar"); // windows separator

        let main = index_of(&a, FORGE_1710_MAIN_CLASS).unwrap();
        assert!(main > cp_idx);

        let after_main = &a[main..];
        assert!(after_main.iter().any(|x| x == "--tweakClass"));
        assert!(after_main.iter().any(|x| x == FORGE_1710_TWEAK_CLASS));
    }

    #[test]
    fn uses_offline_account_defaults_non_empty_32_char_token() {
        let a = build_launch_args(&base());
        let tok_idx = index_of(&a, "--accessToken").unwrap();
        assert_eq!(a[tok_idx + 1], offline_access_token());
        assert_eq!(offline_access_token().len(), 32);

        let up_idx = index_of(&a, "--userProperties").unwrap();
        assert_eq!(a[up_idx + 1], "{}");

        let ut_idx = index_of(&a, "--userType").unwrap();
        assert_eq!(a[ut_idx + 1], "legacy");

        let uuid_idx = index_of(&a, "--uuid").unwrap();
        assert_eq!(a[uuid_idx + 1], "u");

        let un_idx = index_of(&a, "--username").unwrap();
        assert_eq!(a[un_idx + 1], "player");
    }

    #[test]
    fn adds_xstartonfirstthread_only_on_macos() {
        let mut mac = base();
        mac.os = "osx".to_string();
        assert!(build_launch_args(&mac).iter().any(|x| x == "-XstartOnFirstThread"));

        let win = base(); // os == "windows"
        assert!(!build_launch_args(&win).iter().any(|x| x == "-XstartOnFirstThread"));
    }

    #[test]
    fn adds_direct_connect_args_when_a_server_is_given() {
        let mut o = base();
        o.server = Some("play.x.com".to_string());
        o.port = Some(25570);
        let a = build_launch_args(&o);

        let s_idx = index_of(&a, "--server").unwrap();
        assert_eq!(a[s_idx + 1], "play.x.com");

        let p_idx = index_of(&a, "--port").unwrap();
        assert_eq!(a[p_idx + 1], "25570");
    }

    #[test]
    fn uses_the_unix_classpath_separator_on_linux() {
        let mut o = base();
        o.os = "linux".to_string();
        let a = build_launch_args(&o);
        let cp_idx = index_of(&a, "-cp").unwrap();
        assert_eq!(a[cp_idx + 1], "/a.jar:/b.jar");
    }

    // --- extra edge cases (spec is thin on these) ---

    #[test]
    fn default_port_is_25565_when_server_without_port() {
        let mut o = base();
        o.server = Some("host".to_string());
        o.port = None;
        let a = build_launch_args(&o);
        let p_idx = index_of(&a, "--port").unwrap();
        assert_eq!(a[p_idx + 1], "25565");
    }

    #[test]
    fn no_connect_args_when_no_server() {
        let a = build_launch_args(&base());
        assert!(index_of(&a, "--server").is_none());
        assert!(index_of(&a, "--port").is_none());
    }

    #[test]
    fn xms_capped_at_512_when_max_memory_higher() {
        // Xms = min(512, maxMemoryMb): larger max keeps Xms at 512.
        let a = build_launch_args(&base());
        assert!(a.iter().any(|x| x == "-Xms512M"));
    }

    #[test]
    fn xms_follows_max_memory_when_below_512() {
        let mut o = base();
        o.max_memory_mb = 256;
        let a = build_launch_args(&o);
        assert!(a.iter().any(|x| x == "-Xms256M"));
        assert!(a.iter().any(|x| x == "-Xmx256M"));
    }

    #[test]
    fn no_tweak_class_for_vanilla() {
        let mut o = base();
        o.tweak_class = None;
        o.main_class = "net.minecraft.client.main.Main".to_string();
        let a = build_launch_args(&o);
        assert!(index_of(&a, "--tweakClass").is_none());
    }

    #[test]
    fn extra_jvm_args_precede_cp() {
        let mut o = base();
        o.extra_jvm_args = Some(vec!["-XX:+UseG1GC".to_string()]);
        let a = build_launch_args(&o);
        let extra_idx = index_of(&a, "-XX:+UseG1GC").unwrap();
        let cp_idx = index_of(&a, "-cp").unwrap();
        assert!(extra_idx < cp_idx);
    }

    #[test]
    fn explicit_access_token_overrides_offline_default() {
        let mut o = base();
        o.access_token = Some("realtoken".to_string());
        let a = build_launch_args(&o);
        let t_idx = index_of(&a, "--accessToken").unwrap();
        assert_eq!(a[t_idx + 1], "realtoken");
    }

    #[test]
    fn current_os_is_one_of_the_three() {
        let os = current_os();
        assert!(os == "windows" || os == "osx" || os == "linux");
    }
}
