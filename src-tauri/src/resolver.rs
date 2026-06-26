//! Pure helpers for turning a Mojang/Forge version JSON into classpath + natives lists.
//!
//! Faithful Rust port of `version-resolver.ts`. No fs/network/Electron deps — pure functions
//! over inputs (`serde_json::Value` where the TS consumed a parsed JSON object), so the whole
//! module is unit-testable.
//!
//! Crates used: serde, serde_json. (md-5 and semver are not needed by this module.)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Parsed maven coordinate `group:artifact:version[:classifier]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Maven {
    pub group: String,
    pub artifact: String,
    pub version: String,
    pub classifier: Option<String>,
}

/// `g:a:v[:c]` -> Maven. Mirrors the TS `name.split(':')` destructure: missing trailing
/// segments become empty/absent. A 4th (`:`-separated) segment is the classifier.
pub fn parse_maven(name: &str) -> Maven {
    let parts: Vec<&str> = name.split(':').collect();
    let group = parts.first().copied().unwrap_or("").to_string();
    let artifact = parts.get(1).copied().unwrap_or("").to_string();
    let version = parts.get(2).copied().unwrap_or("").to_string();
    let classifier = parts.get(3).map(|s| s.to_string());
    Maven {
        group,
        artifact,
        version,
        classifier,
    }
}

/// `g:a:v[:c]` -> `"g/with/slashes/a/v/a-v[-c].jar"` (the standard maven layout under `libraries/`).
///
/// `classifier_override` (when `Some`) takes precedence over the coord's own classifier,
/// matching the TS `classifierOverride ?? p.classifier`.
pub fn maven_to_path(name: &str, classifier_override: Option<&str>) -> String {
    let p = parse_maven(name);
    // `??` only falls through on null/undefined, so an explicit override (even empty string) wins.
    let classifier: Option<String> = match classifier_override {
        Some(c) => Some(c.to_string()),
        None => p.classifier.clone(),
    };
    let suffix = match &classifier {
        Some(c) => format!("-{}", c),
        None => String::new(),
    };
    let file = format!("{}-{}{}.jar", p.artifact, p.version, suffix);
    let group_path = p.group.replace('.', "/");
    format!("{}/{}/{}/{}", group_path, p.artifact, p.version, file)
}

/// The current build's OS as Mojang names it: "windows" | "osx" | "linux".
pub fn current_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

/// A version-JSON rule. `action` is "allow" | "disallow".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub action: String,
    #[serde(default)]
    pub os: Option<RuleOs>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleOs {
    #[serde(default)]
    pub name: Option<String>,
}

/// Vanilla rule evaluation: start disallowed unless an allow with no os; last matching rule wins.
///
/// `os` is one of "windows" / "osx" / "linux".
pub fn rules_allow(rules: Option<&[Rule]>, os: &str) -> bool {
    match rules {
        None => true,
        Some(rs) if rs.is_empty() => true,
        Some(rs) => {
            let mut allowed = false;
            for r in rs {
                // matches when no os block, no os.name, or os.name == this os.
                let matches = match &r.os {
                    None => true,
                    Some(ro) => match &ro.name {
                        None => true,
                        Some(n) => n == os,
                    },
                };
                if matches {
                    allowed = r.action == "allow";
                }
            }
            allowed
        }
    }
}

/// A (parent+child merged) library entry from a version JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Library {
    pub name: String,
    #[serde(default)]
    pub rules: Option<Vec<Rule>>,
    /// per-os native classifier map, e.g. {"windows":"natives-windows-${arch}"}.
    #[serde(default)]
    pub natives: Option<HashMap<String, String>>,
}

/// Split a (parent+child merged) library list into classpath jars and native jars for this OS,
/// applying rules and the per-os natives classifier (`${arch}` -> `64`).
///
/// Returns `(classpath, natives)`.
///
/// CRITICAL: classpath is deduped by `group:artifact` (last version wins) — Forge ships merged
/// libs and a duplicate ASM/Guava on the `-cp` causes NoSuchMethodError at FML init. We must
/// PRESERVE first-insertion position (the JS `Map` does), so we use an index-map pattern:
/// an ordered `Vec` of keys plus a `HashMap` for last-wins value overwrite.
pub fn resolve_libraries(libs: &[Library], os: &str) -> (Vec<String>, Vec<String>) {
    // Ordered keys (first-insertion order) + value lookup that gets overwritten last-wins.
    let mut order: Vec<String> = Vec::new();
    let mut values: HashMap<String, String> = HashMap::new();
    let mut natives: Vec<String> = Vec::new();

    for lib in libs {
        if !rules_allow(lib.rules.as_deref(), os) {
            continue;
        }
        let native_classifier = lib.natives.as_ref().and_then(|m| m.get(os));
        match native_classifier {
            Some(nc) => {
                // 1.7.10 LWJGL classifiers are plain "natives-<os>" (no ${arch}); replace is a no-op then.
                let replaced = nc.replace("${arch}", "64");
                natives.push(maven_to_path(&lib.name, Some(&replaced)));
            }
            None => {
                let p = parse_maven(&lib.name);
                let key = format!("{}:{}", p.group, p.artifact);
                let path = maven_to_path(&lib.name, None);
                if !values.contains_key(&key) {
                    order.push(key.clone());
                }
                values.insert(key, path);
            }
        }
    }

    let classpath: Vec<String> = order
        .into_iter()
        .map(|k| values.get(&k).cloned().unwrap_or_default())
        .collect();
    (classpath, natives)
}

/// Classpath separator: ";" on windows, ":" elsewhere.
pub fn classpath_separator(os: &str) -> &'static str {
    if os == "windows" {
        ";"
    } else {
        ":"
    }
}

/// Result of parsing a (1.7.10 self-contained) Forge version JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedVersion {
    pub id: String,
    /// base client jar id (versions/<vanilla_id>/<vanilla_id>.jar)
    pub vanilla_id: String,
    pub main_class: String,
    pub tweak_class: Option<String>,
    pub asset_index: String,
    pub libraries: Vec<Library>,
}

/// Parse a (1.7.10 self-contained) Forge version JSON. 1.7.10 Forge does NOT use `inheritsFrom`
/// for libraries — its `libraries` array is already the merged set; we just also need the base
/// vanilla jar. tweakClass is read out of `minecraftArguments`.
pub fn parse_version_json(json: &serde_json::Value) -> ParsedVersion {
    let args = json
        .get("minecraftArguments")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // /--tweakClass\s+(\S+)/ : capture the token after "--tweakClass" + whitespace.
    let tweak_class = extract_tweak_class(args);

    // assetIndex.id ?? (json.assets if string) ?? "1.7.10"
    let asset_index = json
        .get("assetIndex")
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            json.get("assets")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "1.7.10".to_string());

    // (jar if non-empty string) || (inheritsFrom if string) || (id if string) || "1.7.10"
    // The TS `(typeof x === 'string' && x) || next` short-circuits on empty string too,
    // so an empty `jar` falls through.
    let str_or_none = |key: &str| -> Option<String> {
        json.get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    let vanilla_id = str_or_none("jar")
        .or_else(|| str_or_none("inheritsFrom"))
        .or_else(|| str_or_none("id"))
        .unwrap_or_else(|| "1.7.10".to_string());

    let id = json
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "1.7.10".to_string());

    let main_class = json
        .get("mainClass")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "net.minecraft.launchwrapper.Launch".to_string());

    let libraries: Vec<Library> = json
        .get("libraries")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| serde_json::from_value::<Library>(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    ParsedVersion {
        id,
        vanilla_id,
        main_class,
        tweak_class,
        asset_index,
        libraries,
    }
}

/// Faithful port of `/--tweakClass\s+(\S+)/.exec(args)`: find "--tweakClass" followed by one or
/// more whitespace chars, then capture the run of non-whitespace chars that follows.
fn extract_tweak_class(args: &str) -> Option<String> {
    const MARKER: &str = "--tweakClass";
    let mut search_from = 0;
    while let Some(rel) = args[search_from..].find(MARKER) {
        let after = search_from + rel + MARKER.len();
        let rest = &args[after..];
        // require at least one whitespace char (\s+)
        let trimmed = rest.trim_start_matches(|c: char| c.is_whitespace());
        if trimmed.len() < rest.len() {
            // there was whitespace; capture \S+
            let token: String = trimmed
                .chars()
                .take_while(|c| !c.is_whitespace())
                .collect();
            if !token.is_empty() {
                return Some(token);
            }
        }
        search_from = after;
    }
    None
}

/// 1.7.10's standard asset index is content-addressed (NOT virtual). Only materialize a virtual
/// human-readable tree when the index actually declares it (genuinely-legacy packs).
pub fn assets_need_virtual(idx: &serde_json::Value) -> bool {
    idx.get("virtual") == Some(&serde_json::Value::Bool(true))
        || idx.get("map_to_resources") == Some(&serde_json::Value::Bool(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- translated directly from version-resolver.spec.ts ----

    #[test]
    fn maps_maven_coords_to_library_paths() {
        assert_eq!(
            maven_to_path("com.google.guava:guava:17.0", None),
            "com/google/guava/guava/17.0/guava-17.0.jar"
        );
        assert_eq!(
            maven_to_path("net.minecraft:launchwrapper:1.12", None),
            "net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar"
        );
    }

    #[test]
    fn applies_the_native_classifier_with_arch_substitution() {
        let mut natives_map = HashMap::new();
        natives_map.insert("windows".to_string(), "natives-windows".to_string());
        natives_map.insert("linux".to_string(), "natives-linux".to_string());
        natives_map.insert("osx".to_string(), "natives-osx".to_string());
        let libs = vec![Library {
            name: "org.lwjgl.lwjgl:lwjgl-platform:2.9.1".to_string(),
            rules: None,
            natives: Some(natives_map),
        }];
        let (classpath, natives) = resolve_libraries(&libs, "windows");
        assert_eq!(
            natives,
            vec!["org/lwjgl/lwjgl/lwjgl-platform/2.9.1/lwjgl-platform-2.9.1-natives-windows.jar"]
        );
        assert!(classpath.is_empty());
    }

    #[test]
    fn puts_non_native_libs_on_the_classpath() {
        let libs = vec![Library {
            name: "a.b:c:1".to_string(),
            rules: None,
            natives: None,
        }];
        let (classpath, natives) = resolve_libraries(&libs, "linux");
        assert_eq!(classpath, vec!["a/b/c/1/c-1.jar"]);
        assert!(natives.is_empty());
    }

    #[test]
    fn dedups_classpath_by_group_artifact_last_version_wins() {
        let libs = vec![
            Library {
                name: "com.google.guava:guava:15.0".to_string(),
                rules: None,
                natives: None,
            },
            Library {
                name: "com.google.guava:guava:17.0".to_string(),
                rules: None,
                natives: None,
            },
        ];
        let (classpath, _) = resolve_libraries(&libs, "linux");
        assert_eq!(classpath, vec!["com/google/guava/guava/17.0/guava-17.0.jar"]);
    }

    #[test]
    fn honors_os_allow_disallow_rules() {
        let rules = vec![
            Rule {
                action: "allow".to_string(),
                os: None,
            },
            Rule {
                action: "disallow".to_string(),
                os: Some(RuleOs {
                    name: Some("osx".to_string()),
                }),
            },
        ];
        assert!(rules_allow(Some(&rules), "windows"));
        assert!(!rules_allow(Some(&rules), "osx"));
        assert!(rules_allow(None, "linux"));
    }

    #[test]
    fn maps_platform_to_separator_and_os_name() {
        assert_eq!(classpath_separator("windows"), ";");
        assert_eq!(classpath_separator("linux"), ":");
        // osName('darwin') -> 'osx', osName('win32') -> 'windows' in TS; the Rust equivalent is
        // current_os(), which we can't parametrize by an arbitrary platform string. We assert it
        // returns one of the valid Mojang names for the host.
        let os = current_os();
        assert!(os == "windows" || os == "osx" || os == "linux");
    }

    #[test]
    fn parses_a_1_7_10_forge_version_json() {
        let v = parse_version_json(&json!({
            "id": "1.7.10-Forge10.13.4.1614-1.7.10",
            "jar": "1.7.10",
            "assets": "1.7.10",
            "mainClass": "net.minecraft.launchwrapper.Launch",
            "minecraftArguments": "--username ${auth_player_name} --tweakClass cpw.mods.fml.common.launcher.FMLTweaker",
            "libraries": [{ "name": "a.b:c:1" }],
        }));
        assert_eq!(v.vanilla_id, "1.7.10");
        assert_eq!(v.main_class, "net.minecraft.launchwrapper.Launch");
        assert_eq!(
            v.tweak_class.as_deref(),
            Some("cpw.mods.fml.common.launcher.FMLTweaker")
        );
        assert_eq!(v.asset_index, "1.7.10");
        assert_eq!(v.libraries.len(), 1);
    }

    #[test]
    fn decides_virtual_assets_only_when_the_index_declares_it() {
        assert!(!assets_need_virtual(&json!({ "objects": {} }))); // standard 1.7.10
        assert!(assets_need_virtual(&json!({ "virtual": true })));
        assert!(assets_need_virtual(&json!({ "map_to_resources": true })));
    }

    // ---- extra edge cases ----

    #[test]
    fn maven_to_path_honors_classifier_override_and_embedded_classifier() {
        // override beats the coord's own classifier
        assert_eq!(
            maven_to_path("a.b:c:1:sources", Some("natives-linux")),
            "a/b/c/1/c-1-natives-linux.jar"
        );
        // coord-embedded classifier used when no override
        assert_eq!(
            maven_to_path("a.b:c:1:sources", None),
            "a/b/c/1/c-1-sources.jar"
        );
    }

    #[test]
    fn parse_maven_basic() {
        let m = parse_maven("com.google.guava:guava:17.0:natives-windows");
        assert_eq!(m.group, "com.google.guava");
        assert_eq!(m.artifact, "guava");
        assert_eq!(m.version, "17.0");
        assert_eq!(m.classifier.as_deref(), Some("natives-windows"));
    }

    #[test]
    fn arch_substitution_replaces_arch_placeholder() {
        let mut natives_map = HashMap::new();
        natives_map.insert(
            "windows".to_string(),
            "natives-windows-${arch}".to_string(),
        );
        let libs = vec![Library {
            name: "org.lwjgl.lwjgl:lwjgl-platform:2.9.1".to_string(),
            rules: None,
            natives: Some(natives_map),
        }];
        let (_, natives) = resolve_libraries(&libs, "windows");
        assert_eq!(
            natives,
            vec!["org/lwjgl/lwjgl/lwjgl-platform/2.9.1/lwjgl-platform-2.9.1-natives-windows-64.jar"]
        );
    }

    #[test]
    fn dedup_preserves_first_insertion_position() {
        // guava appears first, then asm, then guava again (newer). guava must keep slot 0.
        let libs = vec![
            Library {
                name: "com.google.guava:guava:15.0".to_string(),
                rules: None,
                natives: None,
            },
            Library {
                name: "org.ow2.asm:asm:5.0".to_string(),
                rules: None,
                natives: None,
            },
            Library {
                name: "com.google.guava:guava:17.0".to_string(),
                rules: None,
                natives: None,
            },
        ];
        let (classpath, _) = resolve_libraries(&libs, "linux");
        assert_eq!(
            classpath,
            vec![
                "com/google/guava/guava/17.0/guava-17.0.jar",
                "org/ow2/asm/asm/5.0/asm-5.0.jar"
            ]
        );
    }

    #[test]
    fn disallowed_libs_are_dropped_from_classpath() {
        let libs = vec![Library {
            name: "a.b:c:1".to_string(),
            rules: Some(vec![Rule {
                action: "disallow".to_string(),
                os: None,
            }]),
            natives: None,
        }];
        let (classpath, natives) = resolve_libraries(&libs, "linux");
        assert!(classpath.is_empty());
        assert!(natives.is_empty());
    }

    #[test]
    fn parse_version_json_defaults_when_fields_missing() {
        let v = parse_version_json(&json!({}));
        assert_eq!(v.id, "1.7.10");
        assert_eq!(v.vanilla_id, "1.7.10");
        assert_eq!(v.main_class, "net.minecraft.launchwrapper.Launch");
        assert_eq!(v.tweak_class, None);
        assert_eq!(v.asset_index, "1.7.10");
        assert!(v.libraries.is_empty());
    }

    #[test]
    fn parse_version_json_prefers_asset_index_id() {
        let v = parse_version_json(&json!({
            "assetIndex": { "id": "5" },
            "assets": "1.7.10",
        }));
        assert_eq!(v.asset_index, "5");
    }

    #[test]
    fn parse_version_json_vanilla_id_falls_through_to_inherits_from() {
        let v = parse_version_json(&json!({
            "inheritsFrom": "1.12.2",
            "id": "1.12.2-forge",
        }));
        assert_eq!(v.vanilla_id, "1.12.2");
    }
}
