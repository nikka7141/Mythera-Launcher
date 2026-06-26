//! Offline-mode identity — derives a player's offline-mode UUID from their username.
//!
//! `username` is case-INSENSITIVE for login/uniqueness, but the offline UUID
//! (UUIDv3) is byte/case-SENSITIVE. If two sides derive the UUID from different
//! casings, "Bob" and "bob" collide on login yet map to two different UUIDs. To
//! prevent that, the canonical UUID INPUT is ALWAYS derived from the normalized
//! (trimmed + lower-cased) username.
//!
//! The resulting UUID matches the value the Minecraft client derives itself, i.e.
//! java `UUID.nameUUIDFromBytes(("OfflinePlayer:"+name).getBytes(UTF_8))`:
//! MD5 (version 3) over the raw UTF-8 bytes, version/variant bits forced.

use md5::{Digest, Md5};

/// Prefix every offline username is hashed under (Minecraft offline-mode convention).
pub const OFFLINE_PLAYER_PREFIX: &str = "OfflinePlayer:";

/// Returns the current target OS as the launcher-canonical token.
///
/// Not used by this module's logic, but exposed for parity with the rest of the
/// ported launch modules ("windows" | "osx" | "linux").
pub fn current_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

/// Canonical username normalization. Apply before storage-compare and UUID
/// derivation. Mirrors TS `name.trim().toLowerCase()`.
///
/// NOTE: `to_lowercase()` is Unicode-aware (matches JS `toLowerCase` for the
/// ASCII names this platform allows). `trim()` strips leading/trailing
/// whitespace identically.
pub fn normalize_username(username: &str) -> String {
    username.trim().to_lowercase()
}

/// The exact string that must be UUIDv3-hashed to produce mc_uuid.
/// Mirrors TS `` `OfflinePlayer:${normalizeUsername(name)}` ``.
pub fn offline_uuid_input(username: &str) -> String {
    format!("{}{}", OFFLINE_PLAYER_PREFIX, normalize_username(username))
}

/// Vanilla-offline player UUID — MUST equal the backend's `offlineUuid` and the
/// value the MC client derives itself:
/// `UUID.nameUUIDFromBytes(("OfflinePlayer:"+lower(name)).getBytes(UTF_8))`.
///
/// MD5 (version 3) over the raw UTF-8 bytes of [`offline_uuid_input`], then the
/// version nibble (byte 6) and the IETF variant bits (byte 8) are forced, and
/// the 16 bytes are rendered as lowercase 8-4-4-4-12 hex.
pub fn offline_uuid(username: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(offline_uuid_input(username).as_bytes());
    let mut d = hasher.finalize(); // GenericArray<u8, 16>

    d[6] = (d[6] & 0x0f) | 0x30; // version 3
    d[8] = (d[8] & 0x3f) | 0x80; // IETF variant

    // Lowercase hex of all 16 bytes, then split 8-4-4-4-12.
    let hex: String = d.iter().map(|b| format!("{:02x}", b)).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32],
    )
}

/// Some MC arg paths want the dashless form.
pub fn offline_uuid_no_dashes(username: &str) -> String {
    offline_uuid(username).replace('-', "")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Independent reference impl of
    /// java `UUID.nameUUIDFromBytes("OfflinePlayer:"+lower(name))`.
    /// (Mirrors the `reference()` helper in offline-uuid.spec.ts — note the spec
    /// uses only `toLowerCase()`, no trim, but its inputs have no whitespace.)
    fn reference(name: &str) -> String {
        let mut hasher = Md5::new();
        hasher.update(format!("OfflinePlayer:{}", name.to_lowercase()).as_bytes());
        let mut md5 = hasher.finalize();
        md5[6] = (md5[6] & 0x0f) | 0x30;
        md5[8] = (md5[8] & 0x3f) | 0x80;
        let h: String = md5.iter().map(|b| format!("{:02x}", b)).collect();
        format!(
            "{}-{}-{}-{}-{}",
            &h[0..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..32],
        )
    }

    #[test]
    fn matches_the_java_name_uuid_from_bytes_reference() {
        for name in ["Notch", "player", "GunCraftPro", "a"] {
            assert_eq!(offline_uuid(name), reference(name));
        }
    }

    #[test]
    fn matches_the_externally_known_canonical_uuid() {
        // jeb_ is lowercase, so our lower-casing input equals java's
        // "OfflinePlayer:jeb_". Value cross-checked against the launch-contract
        // review (java UUID.nameUUIDFromBytes).
        assert_eq!(offline_uuid("jeb_"), "a762f560-4fce-3236-812a-b80efff0b62b");
        // case-insensitive
        assert_eq!(offline_uuid("JEB_"), "a762f560-4fce-3236-812a-b80efff0b62b");
    }

    #[test]
    fn produces_a_valid_version3_ietf_variant_uuid() {
        let u = offline_uuid("SomePlayer");
        // ^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
        let parts: Vec<&str> = u.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 4);
        assert_eq!(parts[2].len(), 4);
        assert_eq!(parts[3].len(), 4);
        assert_eq!(parts[4].len(), 12);
        assert!(u.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
        assert!(u.chars().all(|c| c == '-' || !c.is_ascii_uppercase()));
        // version nibble == '3'
        assert_eq!(parts[2].chars().next().unwrap(), '3');
        // IETF variant: first nibble of group 4 is one of 8,9,a,b
        assert!(matches!(parts[3].chars().next().unwrap(), '8' | '9' | 'a' | 'b'));
    }

    #[test]
    fn is_case_insensitive() {
        assert_eq!(offline_uuid("Player"), offline_uuid("player"));
    }

    #[test]
    fn dashless_form_is_the_same_hex_without_separators() {
        let u = offline_uuid("Player");
        assert_eq!(offline_uuid_no_dashes("Player"), u.replace('-', ""));
        assert_eq!(offline_uuid_no_dashes("Player").len(), 32);
    }

    // --- extra edge cases ---

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(normalize_username("  Bob  "), "bob");
        assert_eq!(offline_uuid_input("  Bob  "), "OfflinePlayer:bob");
    }

    #[test]
    fn trim_makes_padded_name_equal_to_bare_name() {
        // The real impl trims (the spec's reference did not); padded input must
        // still resolve to the same persona.
        assert_eq!(offline_uuid("  jeb_  "), "a762f560-4fce-3236-812a-b80efff0b62b");
    }
}
