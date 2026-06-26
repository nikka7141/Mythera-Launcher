//! Launcher version-gating decision (port of `electron/version-gate.ts`).
//!
//! Pure logic with no Electron / Node / filesystem deps so it stays unit-testable.
//! The two booleans drive the launcher's update flow:
//!   - `must_update`      : current build is below the minimum supported -> blocked.
//!   - `update_available` : current build differs from the published `latest` -> apply.
//!     Note this is an *inequality*, not "older than": when an admin rolls the published
//!     build BACK to an older version, clients that are newer still see it as an available
//!     update and (with allowDowngrade) move down to it.
//!
//! Invalid-version safety: this mirrors the original JS `semver.valid(a) && semver.valid(b)`
//! guards. If EITHER version fails to parse, the comparison yields `false` — so a garbage
//! version string can never accidentally block a user or force a phantom update.

use semver::Version;

/// Version-gating decision. Crosses the Tauri/JSON boundary, so it (de)serializes
/// with the original camelCase field names (`mustUpdate`, `updateAvailable`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    /// current < minSupported -> blocked.
    pub must_update: bool,
    /// current != latest -> apply (upgrade OR admin rollback/downgrade).
    pub update_available: bool,
}

/// `semver.lt(a, b)` guarded by `semver.valid` on both operands.
/// Returns `false` if either version is invalid (the JS `!!semver.valid(...)` guard).
fn lt(a: &str, b: &str) -> bool {
    match (Version::parse(a), Version::parse(b)) {
        (Ok(va), Ok(vb)) => va < vb,
        _ => false,
    }
}

/// `!semver.eq(a, b)` guarded by `semver.valid` on both operands.
/// Returns `false` if either version is invalid (mirrors the JS guard).
fn neq(a: &str, b: &str) -> bool {
    match (Version::parse(a), Version::parse(b)) {
        (Ok(va), Ok(vb)) => va != vb,
        _ => false,
    }
}

/// Pure version-gating decision (no platform deps -> unit-testable).
///
/// The app's versions look like `"1.0.3"` (strict SemVer), so `Version::parse`
/// is the faithful equivalent of the original `semver.valid` / `semver.lt` / `semver.eq`.
pub fn gate(current: &str, latest: &str, min_supported: &str) -> Gate {
    Gate {
        must_update: lt(current, min_supported),
        // Any mismatch with the published version — so when the admin rolls back to an
        // older build, clients see it as an available update and move to it.
        update_available: neq(current, latest),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Cases translated 1:1 from version-gate.spec.ts ----

    #[test]
    fn blocks_below_min_supported() {
        let g = gate("1.0.0", "1.0.3", "1.0.3");
        assert!(g.must_update);
        assert!(g.update_available);

        let g = gate("1.0.2", "1.0.3", "1.0.3");
        assert!(g.must_update);
        assert!(g.update_available);
    }

    #[test]
    fn optional_update_between_min_and_latest() {
        let g = gate("1.0.3", "1.0.5", "1.0.3");
        assert!(!g.must_update);
        assert!(g.update_available);
    }

    #[test]
    fn up_to_date_exact_match_no_prompt() {
        let g = gate("1.0.5", "1.0.5", "1.0.3");
        assert!(!g.must_update);
        assert!(!g.update_available);
    }

    #[test]
    fn admin_rollback_client_newer_offers_downgrade() {
        let g = gate("1.1.0", "1.0.5", "1.0.3");
        assert!(!g.must_update);
        assert!(g.update_available);
    }

    #[test]
    fn handles_invalid_versions_safely() {
        // latest unparseable + empty minSupported -> no gating at all.
        let g = gate("1.0.0", "not-a-version", "");
        assert!(!g.must_update);
        assert!(!g.update_available);
    }

    // ---- Extra edge cases (spec is thin on invalid inputs / boundaries) ----

    #[test]
    fn both_invalid_yields_no_gating() {
        let g = gate("", "", "");
        assert!(!g.must_update);
        assert!(!g.update_available);
    }

    #[test]
    fn current_invalid_does_not_force_update() {
        // current can't be compared, so neither flag may fire.
        let g = gate("garbage", "1.0.5", "1.0.3");
        assert!(!g.must_update);
        assert!(!g.update_available);
    }

    #[test]
    fn equal_to_min_supported_is_not_blocked() {
        // current == minSupported -> not strictly less-than -> not blocked.
        let g = gate("1.0.3", "1.0.3", "1.0.3");
        assert!(!g.must_update);
        assert!(!g.update_available);
    }
}
