// Tauri (Rust) bridge backing the `window.mc` object the renderer (App.tsx) talks to: invoke() for
// request/response, listen() for the streamed events. This is the launcher's only native bridge — the
// former Electron main/preload was removed in the full Tauri migration.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { makeDevBridge } from './mc-bridge.dev';

/** Wrap a Tauri event as the synchronous-unsubscribe listener shape the renderer expects. */
function makeListener<T>(event: string) {
  return (cb: (p: T) => void): (() => void) => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<T>(event, (e) => cb(e.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  };
}

function detectPlatform(): NodeJS.Platform {
  const ua = navigator.userAgent;
  if (ua.includes('Win')) return 'win32';
  if (ua.includes('Mac')) return 'darwin';
  return 'linux';
}

const tauriBridge: McBridge = {
  platform: detectPlatform(),
  login: (creds) => invoke<McUser>('login', { creds }),
  register: (creds) => invoke<McUser>('register', { creds }),
  recoverLookup: () => invoke<{ accounts: { username: string }[] }>('recover_lookup'),
  recoverReset: (args) => invoke<{ ok: boolean }>('recover_reset', { args }),
  logout: () => invoke<boolean>('logout'),
  session: () => invoke<McUser | null>('session'),
  refreshUser: () => invoke<McUser>('refresh_user'),
  uploadSkin: (bytes) => invoke<{ skinUrl: string }>('upload_skin', { bytes }),
  servers: () => invoke<McServer[]>('servers'),
  setFavorite: (serverId, favorite) => invoke<{ favorite: boolean }>('set_favorite', { serverId, favorite }),
  serverStatus: (serverId) => invoke<McServerStatus>('server_status', { serverId }),
  playerStats: (serverId) =>
    invoke<{ stats: Record<string, string | number | boolean | null> | null; updatedAt?: string | null }>(
      'player_stats',
      { serverId },
    ),
  installed: (serverId) => invoke<boolean>('installed', { serverId }),
  install: (serverId) => invoke<{ installed: boolean }>('install', { serverId }),
  sync: (serverId) => invoke<McSyncResult>('sync_server', { serverId }),
  cancelSync: (serverId) => invoke<void>('cancel_sync', { serverId }),
  launch: (serverId) => invoke<{ pid: number | null }>('launch', { serverId }),
  updateStatus: () => invoke<McUpdateStatus>('update_status'),
  updateNow: () => invoke<{ started: boolean }>('update_now'),
  getSettings: () => invoke<McSettings>('get_settings'),
  saveSettings: (settings) => invoke<McSettings>('save_settings', { settings }),
  browseGameDir: () => invoke<string | null>('browse_game_dir'),
  onUpdateProgress: makeListener<{ percent: number }>('mc:update-progress'),
  onUpdateError: makeListener<{ message: string }>('mc:update-error'),
  onSyncProgress: makeListener<McSyncProgress>('mc:sync-progress'),
  onLaunchLog: makeListener<McLaunchLog>('mc:launch-log'),
  onLaunchExit: makeListener<McLaunchExit>('mc:launch-exit'),
};

// Tauri injects __TAURI_INTERNALS__ into the renderer; its absence means we're in a plain browser
// (design/dev work at :5173). There, in DEV, swap in the fetch-backed dev shim. The `import.meta.env.DEV`
// guard lets the bundler dead-code-eliminate makeDevBridge from production builds.
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
window.mc = !isTauri && import.meta.env.DEV ? makeDevBridge() : tauriBridge;
