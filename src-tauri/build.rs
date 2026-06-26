fn main() {
    // Bake the public backend URL into the binary (mirrors the old electron-builder.config.js). Precedence:
    // shell VITE_API_URL (CI) > .env.production > (none -> runtime localhost fallback).
    let api = std::env::var("VITE_API_URL").ok().or_else(|| {
        std::fs::read_to_string("../.env.production").ok().and_then(|txt| {
            txt.lines().find_map(|line| {
                line.strip_prefix("VITE_API_URL=")
                    .map(|v| v.trim().trim_matches(['"', '\'']).to_string())
            })
        })
    });
    if let Some(url) = api {
        if !url.is_empty() {
            println!("cargo:rustc-env=MYTHERA_API_URL={url}");
        }
    }
    println!("cargo:rerun-if-changed=../.env.production");
    println!("cargo:rerun-if-env-changed=VITE_API_URL");

    tauri_build::build()
}
