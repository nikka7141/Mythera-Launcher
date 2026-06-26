# Mythera Launcher

[![Build](https://github.com/nikka7141/Mythera-Launcher/actions/workflows/build.yml/badge.svg)](https://github.com/nikka7141/Mythera-Launcher/actions/workflows/build.yml)

The official desktop launcher for **[Mythera](https://mythera.ge)** — a Minecraft server platform.
It signs you in, downloads/verifies the game files, and launches Minecraft.

Built with **Tauri 2** (Rust + WebView2) and **React + Vite**. The compiled Windows installer is small
(~2.4&nbsp;MB) and installs per-user (no administrator rights required).

## Features

- Account sign-in against the Mythera backend, with the session token stored in the OS keychain.
- Content sync with SHA-256 verification and path-traversal protection.
- Managed Java (JRE) provisioning and game launch.
- Built-in self-updater that pulls signed installers from the public release feed.

## Develop

Requirements: [Node 20+](https://nodejs.org), [pnpm](https://pnpm.io), and the
[Rust toolchain](https://www.rust-lang.org/tools/install) + the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
pnpm tauri dev        # run the desktop app in dev mode
```

UI-only design work in a browser (no Tauri shell) is also possible at `http://localhost:5173`:

```bash
pnpm dev
```

## Build

```bash
pnpm tauri build --bundles nsis    # Windows installer -> src-tauri/target/release/bundle/nsis
```

## Configuration

Public build config lives in [`.env.production`](./.env.production) — these are **public** URLs (no
secrets) baked into the shipped app:

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Public backend API base (also baked into the Rust binary by `src-tauri/build.rs`). |
| `LAUNCHER_FEED_URL` | Update feed the in-app updater (`src-tauri/src/updater.rs`) consumes. |

The Vite build refuses to bake a `localhost`/empty API URL into a packaged build (set
`ALLOW_LOCALHOST_BUILD=1` for an intentional local test build).

## Code signing

Release installers are signed via the **[SignPath Foundation](https://signpath.org)** free code-signing
program for open-source projects. The signing certificate's private key is held by SignPath and never
exists in this repository or its CI. Until signing is active, downloaded builds are unsigned and Windows
SmartScreen may warn on first run.

## License

[MIT](./LICENSE) © Mythera
