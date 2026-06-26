// DEV-ONLY browser bridge. Under Tauri the renderer talks to the Rust `window.mc`; in a plain browser
// (http://localhost:5173, used for design work) there is no Tauri, so this shim fills `window.mc`:
//   - auth / servers / status / refresh  -> the REAL backend over /api/v1 (vite proxies it to :3001),
//     mirroring the website's token scheme (mc_access / mc_refresh, refresh-on-401, {error:{message}}).
//   - install / sync / launch / update   -> SIMULATED (fake progress + launch events, a localStorage
//     "installed" flag) so the post-install Play state + progress bars still exercise in the browser.
// `mc-bridge.ts` only imports this when import.meta.env.DEV && !isTauri, so it is compiled out of prod.

const BASE = '/api/v1';
const ACCESS_KEY = 'mc_access';
const REFRESH_KEY = 'mc_refresh';

function detectPlatform(): NodeJS.Platform {
  const ua = navigator.userAgent;
  if (ua.includes('Win')) return 'win32';
  if (ua.includes('Mac')) return 'darwin';
  return 'linux';
}

let refreshing: Promise<string | null> | null = null;
async function tryRefresh(): Promise<string | null> {
  const rt = localStorage.getItem(REFRESH_KEY);
  if (!rt) return null;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        });
        if (!res.ok) throw new Error('refresh failed');
        const data = (await res.json()) as { accessToken: string; refreshToken: string };
        localStorage.setItem(ACCESS_KEY, data.accessToken);
        localStorage.setItem(REFRESH_KEY, data.refreshToken);
        return data.accessToken;
      } catch {
        localStorage.removeItem(ACCESS_KEY);
        localStorage.removeItem(REFRESH_KEY);
        return null;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/** fetch() against the real backend with the stored access token + one transparent refresh-on-401 retry. */
async function api<T>(path: string, opts: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const { auth = true, headers, ...rest } = opts;
  const send = (tok?: string | null) =>
    fetch(`${BASE}${path}`, {
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        ...headers,
      },
    });

  const token = auth ? localStorage.getItem(ACCESS_KEY) : null;
  let res = await send(token);
  if (res.status === 401 && token) {
    const fresh = await tryRefresh();
    if (fresh) res = await send(fresh);
  }

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (body?.error?.message as string) ?? res.statusText;
    throw new Error(message);
  }
  return body as T;
}

// ---- a tiny event bus for the SIMULATED native events (sync/launch/update) ----
type Bus = Record<string, Set<(p: unknown) => void>>;
const bus: Bus = {};
function on<T>(event: string) {
  return (cb: (p: T) => void): (() => void) => {
    (bus[event] ??= new Set()).add(cb as (p: unknown) => void);
    return () => bus[event]?.delete(cb as (p: unknown) => void);
  };
}
function emit(event: string, payload: unknown) {
  bus[event]?.forEach((cb) => cb(payload));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const installedKey = (id: number) => `mc_dev_installed_${id}`;
// Cancellation: a server id added here makes its in-flight simulated install/sync abort at the next step.
const canceledIds = new Set<number>();
class CanceledError extends Error {
  constructor() {
    super('canceled');
  }
}
const SETTINGS_KEY = 'mc_settings';
const DEFAULT_SETTINGS: McSettings = {
  ramMb: 4096,
  maxRamMb: 16384,
  performanceMode: false,
  fullscreen: false,
  closeOnPlay: false,
  gameDir: 'C:\\Users\\you\\AppData\\Roaming\\Mythera',
  autoUpdate: true,
};

/** Store the tokens the backend returned on login/register (same keys the website uses). */
function saveTokens(data: { accessToken?: string; refreshToken?: string }) {
  if (data.accessToken) localStorage.setItem(ACCESS_KEY, data.accessToken);
  if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken);
}

export function makeDevBridge(): McBridge {
  return {
    platform: detectPlatform(),

    async login(creds) {
      const data = await api<{ accessToken: string; refreshToken: string; user: McUser }>('/auth/login', {
        method: 'POST',
        auth: false,
        body: JSON.stringify(creds),
      });
      saveTokens(data);
      return data.user;
    },

    async register(creds) {
      await api('/auth/register', { method: 'POST', auth: false, body: JSON.stringify(creds) });
      const data = await api<{ accessToken: string; refreshToken: string; user: McUser }>('/auth/login', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ username: creds.username, password: creds.password }),
      });
      saveTokens(data);
      return data.user;
    },

    recoverLookup: () =>
      api<{ accounts: { username: string }[] }>('/auth/recover/lookup', { method: 'POST', auth: false }),
    recoverReset: (args) =>
      api<{ ok: boolean }>('/auth/recover/reset', { method: 'POST', auth: false, body: JSON.stringify(args) }),

    async logout() {
      const rt = localStorage.getItem(REFRESH_KEY);
      if (rt) await api('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: rt }) }).catch(() => undefined);
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      return true;
    },

    async session() {
      if (!localStorage.getItem(ACCESS_KEY)) return null;
      return api<McUser>('/auth/me').catch(() => null);
    },

    refreshUser: () => api<McUser>('/auth/me'),
    // Skin upload is multipart — bypass api() (which forces JSON Content-Type) and let the browser set
    // the multipart boundary, mirroring the website's uploadSkin. Refresh once on 401.
    async uploadSkin(bytes) {
      const makeBody = () => {
        const fd = new FormData();
        fd.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'skin.png');
        return fd;
      };
      const send = (tok: string | null) =>
        fetch(`${BASE}/account/skin`, {
          method: 'POST',
          headers: tok ? { Authorization: `Bearer ${tok}` } : {},
          body: makeBody(),
        });
      const token = localStorage.getItem(ACCESS_KEY);
      let res = await send(token);
      if (res.status === 401 && token) {
        const fresh = await tryRefresh();
        if (fresh) res = await send(fresh);
      }
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error((body?.error?.message as string) ?? res.statusText);
      return body as { skinUrl: string };
    },
    servers: () => api<McServer[]>('/servers'),
    setFavorite: (id, favorite) =>
      api<{ favorite: boolean }>(`/servers/${id}/favorite`, { method: favorite ? 'PUT' : 'DELETE' }),
    // Real status from the backend: running/online/max + the SLP player sample with each online player's
    // real Mythera skin (resolved server-side in attachSkins). Empty list when the server is offline.
    serverStatus: (id) => api<McServerStatus>(`/servers/${id}/status`, { auth: false }),

    installed: async (id) => localStorage.getItem(installedKey(id)) === '1',

    async install(id) {
      // Simulate scan -> download N files -> done, then mark installed. Abort if cancelSync(id) fires.
      canceledIds.delete(id);
      const total = 18;
      emit('mc:sync-progress', { serverId: id, phase: 'scan', done: 0, total });
      await sleep(250);
      for (let done = 1; done <= total; done++) {
        if (canceledIds.has(id)) throw new CanceledError();
        emit('mc:sync-progress', { serverId: id, phase: 'download', file: `mods/file-${done}.jar`, done, total });
        await sleep(250);
      }
      emit('mc:sync-progress', { serverId: id, phase: 'done', done: total, total });
      localStorage.setItem(installedKey(id), '1');
      return { installed: true };
    },

    async sync(id) {
      canceledIds.delete(id);
      const total = 18;
      emit('mc:sync-progress', { serverId: id, phase: 'scan', done: 0, total });
      await sleep(300);
      for (let done = 1; done <= total; done++) {
        if (canceledIds.has(id)) throw new CanceledError();
        emit('mc:sync-progress', { serverId: id, phase: 'download', file: `mods/file-${done}.jar`, done, total });
        await sleep(180);
      }
      emit('mc:sync-progress', { serverId: id, phase: 'done', done: total, total });
      localStorage.setItem(installedKey(id), '1');
      return { downloaded: 0, deleted: 0, unchanged: total };
    },

    cancelSync: async (id) => {
      canceledIds.add(id);
    },

    async launch(id) {
      for (const line of ['[dev] Preparing instance…', '[dev] Connecting to server…', '[dev] Launching game…']) {
        emit('mc:launch-log', { serverId: id, line });
        await sleep(300);
      }
      // In a browser there is no real game; auto-"exit" after a few seconds so the UI state resets.
      setTimeout(() => emit('mc:launch-exit', { serverId: id, code: 0 }), 8000);
      return { pid: 1234 };
    },

    // Dev never blocks on a version gate.
    updateStatus: async () => ({
      current: '1.0.7',
      latest: '1.0.7',
      minSupported: '1.0.0',
      mustUpdate: false,
      updateAvailable: false,
      packaged: false,
    }),
    updateNow: async () => ({ started: false }),

    async getSettings() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<McSettings>) } : { ...DEFAULT_SETTINGS };
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    },
    async saveSettings(settings) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      return settings;
    },
    // No native folder picker in a plain browser — keep the current path.
    browseGameDir: async () => null,

    onUpdateProgress: on<{ percent: number }>('mc:update-progress'),
    onUpdateError: on<{ message: string }>('mc:update-error'),
    onSyncProgress: on<McSyncProgress>('mc:sync-progress'),
    onLaunchLog: on<McLaunchLog>('mc:launch-log'),
    onLaunchExit: on<McLaunchExit>('mc:launch-exit'),
  };
}
