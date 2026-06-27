import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import logoUrl from './assets/mythera-logo.webp';
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CoinIcon,
  CpuIcon,
  CubeIcon,
  DiamondIcon,
  DownloadIcon,
  FolderIcon,
  GaugeIcon,
  GearIcon,
  LogoutIcon,
  MaximizeIcon,
  MinimizeIcon,
  ModeIcon,
  MonitorIcon,
  PlayIcon,
  RefreshIcon,
  StarIcon,
  StarOutlineIcon,
  SwordsIcon,
  UploadIcon,
  UsersIcon,
} from './icons';
import { SkinFace } from './skin-face';
import { SkinPreview3D } from './skin-preview-3d';
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from './window-controls';

/* ---------- display helpers (all derived from REAL server fields) ---------- */
const SERVER_TYPE_LABEL: Record<string, string> = {
  survival: 'Survival',
  minigame: 'Minigame',
  roleplay: 'Roleplay',
};
// Combat mode from the server's server.properties `pvp` flag (set in the admin Properties editor).
const modeLabel = (s: McServer): string => (s.pvp === false ? 'PvE' : 'PvP');
// Only Featured / In-development groups can be collapsed in the sidebar (Favorites + Public stay open).
const COLLAPSIBLE_GROUPS = new Set(['featured', 'in_development']);
// Player-face sizing (must match .face/.faces in index.css) — drives the responsive "fit as many as fit".
const FACE_W = 36;
const FACE_GAP = 8;
const CHIP_W = 58;
// Human labels for the sync phases shown above the full-width download bar.
const PHASE_LABEL: Record<string, string> = {
  scan: 'Scanning files',
  download: 'Downloading',
  cleanup: 'Cleaning up',
  done: 'Finishing',
};
function heroEyebrow(s: McServer): string {
  if (s.statusMode === 'featured') return 'Featured server';
  if (s.statusMode === 'in_development') return 'In development';
  return 'Selected server';
}
/** Split the name like the design: first word on one line, the rest accented. */
function splitTitle(name: string): [string, string] {
  const i = name.indexOf(' ');
  return i === -1 ? ['', name] : [name.slice(0, i), name.slice(i + 1)];
}
/** First sentence -> tagline, the rest -> body paragraph (so the hero copy is all real description text). */
function splitDescription(desc: string): { tagline: string; body: string } {
  const d = (desc ?? '').trim();
  if (!d) return { tagline: '', body: '' };
  const m = d.match(/^(.*?[.!?])\s+(.*)$/s);
  if (m) return { tagline: m[1].trim(), body: m[2].trim() };
  return { tagline: d, body: '' };
}
// Prefer the player's real Mythera skin (resolved server-side); else a UUID/name-based render (Steve on miss).
const skinUrlFor = (p: { id: string; name: string; skinUrl?: string | null }) =>
  p.skinUrl || `https://mc-heads.net/skin/${encodeURIComponent(p.id || p.name)}`;

/** A pill toggle switch (settings rows). */
function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`switch${on ? ' on' : ''}`} role="switch" aria-checked={on} onClick={onClick}>
      <span className="switch-knob" />
    </button>
  );
}

export default function App() {
  const mc = window.mc;
  const [user, setUser] = useState<McUser | null>(null);
  const [servers, setServers] = useState<McServer[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'recover'>('login');
  // IP-recovery sub-flow: look up accounts on this IP → pick one → set a new password.
  const [recStep, setRecStep] = useState<'lookup' | 'pick' | 'reset' | 'done'>('lookup');
  const [recAccounts, setRecAccounts] = useState<string[]>([]);
  const [recPicked, setRecPicked] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<McSyncProgress | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [statusMap, setStatusMap] = useState<Record<number, string>>({});
  // Per-server op status (downloading / canceled / launched / …) keyed by id, so it never bleeds onto another server.
  const setSrvStatus = (id: number, text: string) => setStatusMap((m) => ({ ...m, [id]: text }));
  const [lastLog, setLastLog] = useState('');
  const [installed, setInstalled] = useState<Record<number, boolean>>({});
  const [statuses, setStatuses] = useState<Record<number, McServerStatus>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);
  const [upd, setUpd] = useState<McUpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updPct, setUpdPct] = useState<number | null>(null);
  const [updErr, setUpdErr] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const favInFlight = useRef<Set<number>>(new Set());
  const canceledRef = useRef<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Measure the player-faces row so we render exactly as many faces as fit (full-width, responsive).
  const [facesWidth, setFacesWidth] = useState(0);
  const facesRoRef = useRef<ResizeObserver | null>(null);
  const setFacesEl = useCallback((el: HTMLDivElement | null) => {
    facesRoRef.current?.disconnect();
    if (!el) return;
    setFacesWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => setFacesWidth(entries[0].contentRect.width));
    ro.observe(el);
    facesRoRef.current = ro;
  }, []);
  const [view, setView] = useState<'dashboard' | 'settings' | 'profile'>('dashboard');
  const [settings, setSettings] = useState<McSettings | null>(null);
  const [skinBusy, setSkinBusy] = useState(false);
  const [skinErr, setSkinErr] = useState('');
  const [skinMsg, setSkinMsg] = useState('');
  const [skinDragOver, setSkinDragOver] = useState(false);
  const skinInputRef = useRef<HTMLInputElement>(null);

  const refreshMeta = useCallback(
    (list: McServer[]) => {
      for (const s of list) {
        mc.installed(s.id).then((v) => setInstalled((m) => ({ ...m, [s.id]: v }))).catch(() => undefined);
        mc.serverStatus(s.id).then((st) => setStatuses((m) => ({ ...m, [s.id]: st }))).catch(() => undefined);
      }
    },
    [mc],
  );

  useEffect(() => {
    mc.session().then((s) => {
      setUser(s);
      if (s)
        mc.servers().then((list) => {
          setServers(list);
          setSelected((cur) => cur ?? list[0]?.id ?? null);
          refreshMeta(list);
        }).catch(() => undefined);
    });
    mc.updateStatus().then(setUpd).catch(() => undefined);
    mc.getSettings().then(setSettings).catch(() => undefined);
    const offProgress = mc.onSyncProgress(setProgress);
    const offLog = mc.onLaunchLog((p) => setLastLog(p.line.trim().split('\n').pop() ?? ''));
    const offExit = mc.onLaunchExit((p) => {
      setRunningId((cur) => (cur === p.serverId ? null : cur));
      setSrvStatus(p.serverId, `Game exited (code ${p.code ?? '?'})`);
    });
    const offUpdP = mc.onUpdateProgress((p) => setUpdPct(p.percent));
    const offUpdE = mc.onUpdateError((p) => {
      setUpdErr(p.message);
      setUpdating(false);
    });
    return () => {
      offProgress();
      offLog();
      offExit();
      offUpdP();
      offUpdE();
    };
  }, [mc, refreshMeta]);

  useEffect(() => {
    if (!user || servers.length === 0) return;
    const t = setInterval(() => {
      for (const s of servers)
        mc.serverStatus(s.id).then((st) => setStatuses((m) => ({ ...m, [s.id]: st }))).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(t);
  }, [mc, user, servers]);

  // Close the launch dropup on an outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  async function afterAuth(u: McUser) {
    setUser(u);
    const list = await mc.servers();
    setServers(list);
    setSelected(list[0]?.id ?? null);
    refreshMeta(list);
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await afterAuth(await mc.login({ username, password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Login failed');
    }
  }

  async function register(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      setError('Username: 3–16 chars, letters/numbers/_ only.');
      return;
    }
    if (password.length < 8 || !/\D/.test(password)) {
      setError('Password: at least 8 characters and not only digits.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    try {
      await afterAuth(await mc.register({ username, password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Registration failed');
    }
  }

  /** Switch login/register/recover, clearing transient field + recovery state. */
  function switchMode(mode: 'login' | 'register' | 'recover') {
    setError('');
    setPassword('');
    setConfirm('');
    setRecStep('lookup');
    setRecAccounts([]);
    setRecPicked('');
    setAuthMode(mode);
  }

  // Recovery step 1: which accounts registered from this machine's IP?
  async function recoverFind() {
    setError('');
    try {
      const res = await mc.recoverLookup();
      if (res.accounts.length === 0) {
        setError('No accounts were registered from your current network. Recovery only works from the connection you signed up on.');
        return;
      }
      setRecAccounts(res.accounts.map((a) => a.username));
      setRecStep('pick');
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Lookup failed');
    }
  }

  // Recovery step 3: set the new password for the picked account.
  async function recoverReset(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8 || !/\D/.test(password)) {
      setError('Password: at least 8 characters and not only digits.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    try {
      await mc.recoverReset({ username: recPicked, newPassword: password });
      setRecStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Reset failed');
    }
  }

  async function logout() {
    await mc.logout();
    setUser(null);
    setServers([]);
    setSelected(null);
  }

  const [refreshing, setRefreshing] = useState(false);
  async function refreshAll() {
    setRefreshing(true);
    setError('');
    try {
      const [u, list] = await Promise.all([mc.refreshUser(), mc.servers()]);
      setUser(u);
      setServers(list);
      setSelected((cur) => (cur != null && list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null));
      refreshMeta(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleFavorite(id: number) {
    // Ignore re-clicks while a toggle for this id is still in flight — otherwise PUT/DELETE can reorder
    // on the server and the sidecar diverges from the UI.
    if (favInFlight.current.has(id)) return;
    const cur = servers.find((s) => s.id === id)?.isFavorite ?? false;
    favInFlight.current.add(id);
    setServers((list) => list.map((s) => (s.id === id ? { ...s, isFavorite: !cur } : s)));
    try {
      const r = await mc.setFavorite(id, !cur);
      // Reconcile to the server's authoritative answer.
      setServers((list) => list.map((s) => (s.id === id ? { ...s, isFavorite: r.favorite } : s)));
    } catch {
      setServers((list) => list.map((s) => (s.id === id ? { ...s, isFavorite: cur } : s)));
    } finally {
      favInFlight.current.delete(id);
    }
  }

  const toggleGroup = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Performance mode → strip launcher animations/transitions (a real, immediate effect).
  useEffect(() => {
    document.documentElement.classList.toggle('perf', !!settings?.performanceMode);
  }, [settings?.performanceMode]);

  function updateSettings(patch: Partial<McSettings>) {
    setSettings((cur) => {
      if (!cur) return cur;
      const next = { ...cur, ...patch };
      // Persist; surface a real failure instead of silently swallowing it (so a broken save is visible).
      void mc.saveSettings(next).catch((e) =>
        setError(e instanceof Error ? e.message : typeof e === 'string' ? e : 'Could not save settings'),
      );
      return next;
    });
  }

  async function browseGameDir() {
    setError('');
    try {
      const dir = await mc.browseGameDir();
      if (dir) updateSettings({ gameDir: dir });
    } catch (e) {
      setError(e instanceof Error ? e.message : typeof e === 'string' ? e : 'Could not open the folder picker');
    }
  }

  // Validate + upload a Minecraft skin (same rules the backend enforces: PNG, 64×64 or 64×32, ≤256 KB).
  async function onSkinFile(file: File) {
    setSkinErr('');
    setSkinMsg('');
    if (file.size > 262144) {
      setSkinErr('Skin file must be 256 KB or smaller.');
      return;
    }
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) {
      setSkinErr('Skin must be a PNG image.');
      return;
    }
    const dv = new DataView(buf);
    const w = dv.getUint32(16);
    const h = dv.getUint32(20);
    if (!(w === 64 && (h === 64 || h === 32))) {
      setSkinErr(`Skin must be 64×64 (or 64×32) pixels — this is ${w}×${h}.`);
      return;
    }
    setSkinBusy(true);
    try {
      await mc.uploadSkin(Array.from(bytes));
      setUser(await mc.refreshUser());
      setSkinMsg('Skin updated — applied in-game on your next join.');
    } catch (e) {
      setSkinErr(e instanceof Error ? e.message : typeof e === 'string' ? e : 'Skin upload failed.');
    } finally {
      setSkinBusy(false);
    }
  }

  async function doUpdate() {
    setUpdErr('');
    setUpdating(true);
    setUpdPct(0);
    try {
      await mc.updateNow();
    } catch (err) {
      setUpdErr(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Update failed');
      setUpdating(false);
    }
  }

  // A canceled op rejects too — show a calm "Canceled" status instead of a red error.
  function handleOpError(id: number, err: unknown, fallback: string) {
    setProgress(null);
    if (canceledRef.current.delete(id)) {
      setSrvStatus(id, 'Canceled.');
    } else {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : fallback);
      setSrvStatus(id, '');
    }
  }

  async function cancelDownload(id: number) {
    canceledRef.current.add(id);
    setSrvStatus(id, 'Canceling…');
    await mc.cancelSync(id).catch(() => undefined);
  }

  async function download(id: number) {
    setError('');
    setBusy(id);
    try {
      setSrvStatus(id, 'Downloading client + files…');
      await mc.install(id);
      setProgress(null);
      setInstalled((m) => ({ ...m, [id]: true }));
      setSrvStatus(id, 'Downloaded. Ready to play.');
    } catch (err) {
      handleOpError(id, err, 'Download failed');
    } finally {
      setBusy(null);
    }
  }

  async function reinstall(id: number) {
    setMenuOpen(false);
    setError('');
    setBusy(id);
    try {
      setSrvStatus(id, 'Reinstalling all files…');
      await mc.install(id);
      setProgress(null);
      setInstalled((m) => ({ ...m, [id]: true }));
      setSrvStatus(id, 'Reinstalled. Ready to play.');
    } catch (err) {
      handleOpError(id, err, 'Reinstall failed');
    } finally {
      setBusy(null);
    }
  }

  async function verify(id: number) {
    setMenuOpen(false);
    setError('');
    setBusy(id);
    try {
      setSrvStatus(id, 'Verifying files…');
      const r = await mc.sync(id);
      setProgress(null);
      setInstalled((m) => ({ ...m, [id]: true }));
      setSrvStatus(id, `Verified — ${r.downloaded} repaired, ${r.deleted} removed, ${r.unchanged} ok.`);
    } catch (err) {
      handleOpError(id, err, 'Verify failed');
    } finally {
      setBusy(null);
    }
  }

  async function play(id: number) {
    setError('');
    setBusy(id);
    try {
      setSrvStatus(id, 'Verifying files…');
      const r = await mc.sync(id);
      setProgress(null);
      setSrvStatus(id, `Synced (${r.downloaded} new, ${r.deleted} removed). Launching…`);
      await mc.launch(id);
      setInstalled((m) => ({ ...m, [id]: true }));
      setRunningId(id);
      setSrvStatus(id, 'Game launched.');
      if (settings?.closeOnPlay) minimizeWindow();
    } catch (err) {
      handleOpError(id, err, 'Launch failed');
    } finally {
      setBusy(null);
    }
  }

  const onlineCount = useMemo(
    () => servers.reduce((n, s) => n + (statuses[s.id]?.running ? 1 : 0), 0),
    [servers, statuses],
  );

  // Sidebar groups: favorites pinned at top (any type), then Public / Featured / In development. One scroll.
  const groups = useMemo(() => {
    const fav = servers.filter((s) => s.isFavorite);
    const rest = servers.filter((s) => !s.isFavorite);
    const byMode = (m: McServer['statusMode']) => rest.filter((s) => (s.statusMode ?? 'published') === m);
    return [
      { key: 'fav', label: 'Favorites', items: fav },
      { key: 'published', label: 'Public', items: byMode('published') },
      { key: 'featured', label: 'Featured', items: byMode('featured') },
      { key: 'in_development', label: 'In development', items: byMode('in_development') },
    ].filter((g) => g.items.length > 0);
  }, [servers]);

  // Hard version gate: below minSupported the launcher is blocked until it updates.
  if (upd?.mustUpdate) {
    return (
      <main className="app">
        <div className="update-modal">
          <h1>Update required</h1>
          <p className="muted">
            Your launcher (v{upd.current}) is no longer supported. Update to v{upd.latest} to continue.
          </p>
          {updErr && <p className="error">{updErr}</p>}
          {updating ? (
            <>
              <div className="pbar">
                <div className={`pfill${updPct === null ? ' indet' : ''}`} style={updPct === null ? undefined : { width: `${updPct}%` }} />
              </div>
              <p className="muted small">{updPct === null ? 'Starting…' : `Downloading ${updPct}%`}</p>
            </>
          ) : (
            <button className="btn lg" onClick={() => void doUpdate()}>
              Update now
            </button>
          )}
          {!upd.packaged && (
            <p className="muted small">(Dev build — install the packaged app to actually update.)</p>
          )}
        </div>
      </main>
    );
  }

  if (!user) {
    const onSubmit =
      authMode === 'login' ? login : authMode === 'register' ? register : recStep === 'reset' ? recoverReset : (e: FormEvent) => e.preventDefault();
    const title = authMode === 'login' ? 'Log in' : authMode === 'register' ? 'Create account' : 'Recover account';
    const sub =
      authMode === 'login'
        ? 'Sign in to download and play on your servers.'
        : authMode === 'register'
          ? 'Create an account to download and play on your servers.'
          : recStep === 'lookup'
            ? 'No email needed — recover the account you created on this connection.'
            : recStep === 'pick'
              ? 'Pick the account you want to recover.'
              : recStep === 'reset'
                ? `Set a new password for "${recPicked}".`
                : 'Password updated.';
    return (
      <main className="app">
        <form className="login" onSubmit={onSubmit}>
          <span className="eyebrow"><img src={logoUrl} className="logo-sm" alt="" /> Mythera</span>
          <h1>{title}</h1>
          <p className="muted small login-sub">{sub}</p>
          {error && <p className="error">{error}</p>}

          {authMode !== 'recover' && (
            <>
              <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
              <input
                type="password"
                placeholder="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {authMode === 'register' && (
                <input
                  type="password"
                  placeholder="repeat password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              )}
              <button className="btn lg">{authMode === 'login' ? 'Log in' : 'Create account'}</button>
              {authMode === 'login' && (
                <button type="button" className="linklike login-forgot" onClick={() => switchMode('recover')}>
                  Forgot password?
                </button>
              )}
            </>
          )}

          {authMode === 'recover' && recStep === 'lookup' && (
            <button type="button" className="btn lg" onClick={() => void recoverFind()}>
              Find my accounts
            </button>
          )}

          {authMode === 'recover' && recStep === 'pick' && (
            <div className="rec-list">
              {recAccounts.map((u) => (
                <button
                  key={u}
                  type="button"
                  className="rec-item"
                  onClick={() => {
                    setRecPicked(u);
                    setError('');
                    setRecStep('reset');
                  }}
                >
                  <span>{u}</span>
                  <span className="muted small">Recover →</span>
                </button>
              ))}
            </div>
          )}

          {authMode === 'recover' && recStep === 'reset' && (
            <>
              <input
                type="password"
                placeholder="new password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
              />
              <input
                type="password"
                placeholder="repeat password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
              <button className="btn lg">Set new password</button>
              <button type="button" className="linklike" onClick={() => setRecStep('pick')}>
                ← Choose a different account
              </button>
            </>
          )}

          {authMode === 'recover' && recStep === 'done' && (
            <>
              <p className="muted small">
                Password updated for <b>{recPicked}</b>. Log in with your new password.
              </p>
              <button type="button" className="btn lg" onClick={() => switchMode('login')}>
                Go to log in
              </button>
            </>
          )}

          <p className="muted small login-switch">
            {authMode === 'login' && (
              <>
                Don&apos;t have an account?{' '}
                <button type="button" className="linklike" onClick={() => switchMode('register')}>
                  Create one
                </button>
              </>
            )}
            {authMode === 'register' && (
              <>
                Already have an account?{' '}
                <button type="button" className="linklike" onClick={() => switchMode('login')}>
                  Log in
                </button>
              </>
            )}
            {authMode === 'recover' && (
              <>
                Remembered it?{' '}
                <button type="button" className="linklike" onClick={() => switchMode('login')}>
                  Back to log in
                </button>
              </>
            )}
          </p>
        </form>
      </main>
    );
  }

  const sel = servers.find((s) => s.id === selected) ?? null;
  const selStatus = sel ? statuses[sel.id] : undefined;
  const selOffline = selStatus?.running === false; // soft hint only — the ping can be a false negative, so this never blocks Play
  const selComingSoon = !!sel && sel.statusMode === 'featured';
  const selLocked = selComingSoon || (!!sel && sel.statusMode === 'in_development' && !sel.isWhitelisted);
  const selInstalled = sel ? installed[sel.id] : false;
  const selRunning = sel != null && runningId === sel.id;
  const otherRunning = runningId !== null && runningId !== selected;
  const selBusy = sel != null && busy === sel.id;
  const selStatusMsg = sel ? statusMap[sel.id] ?? '' : '';
  const selProgress = progress && sel && progress.serverId === sel.id ? progress : null;
  const pct = selProgress && selProgress.total > 0 ? Math.round((selProgress.done / selProgress.total) * 100) : null;
  const ctaDisabled = busy !== null || otherRunning || selRunning;
  // Secondary actions (reinstall/verify) must NOT run while THIS server's game holds file locks.
  const secondaryDisabled = busy !== null || selRunning;
  const onCta = () => sel && void (selInstalled ? play(sel.id) : download(sel.id));
  // Offline is a SOFT hint, never a hard block — the status ping can be a false negative (server up but
  // slow to answer / Docker timing), so Play is never disabled on it. A genuinely offline server just
  // fails to connect in-game. Only coming-soon / in-dev actually lock the button.
  const blocked: { kind: 'soon' | 'dev' | 'offline'; label: string } | null = !sel
    ? null
    : selComingSoon
      ? { kind: 'soon', label: 'Coming soon' }
      : sel.statusMode === 'in_development' && !sel.isWhitelisted
        ? { kind: 'dev', label: 'In development' }
        : null;

  const heroDesc = sel ? splitDescription(sel.description) : { tagline: '', body: '' };
  const [titleHead, titleTail] = sel ? splitTitle(sel.name) : ['', ''];
  const players = selStatus?.players ?? [];
  const maxOnline = selStatus?.max ?? 0;
  const curOnline = selStatus?.online ?? 0;
  const barPct = maxOnline > 0 ? Math.min(100, Math.round((curOnline / maxOnline) * 100)) : 0;
  // Render exactly as many faces as fit the measured row width; a "+N" chip covers the rest.
  const perFace = FACE_W + FACE_GAP;
  const measured = facesWidth || 600;
  const rawFit = Math.max(1, Math.floor((measured + FACE_GAP) / perFace));
  let faceCount: number;
  if (curOnline <= players.length && players.length <= rawFit) {
    faceCount = players.length; // everyone fits, no chip
  } else {
    faceCount = Math.min(players.length, Math.max(1, Math.floor((measured - CHIP_W + FACE_GAP) / perFace)));
  }
  const facesShown = players.slice(0, faceCount);
  const facesExtra = Math.max(0, curOnline - facesShown.length);

  const ramGb = settings ? Math.round(settings.ramMb / 1024) : 0;
  const maxRamGb = settings ? Math.max(2, Math.round(settings.maxRamMb / 1024)) : 16;

  return (
    <div className={`shell${view !== 'dashboard' ? ' mode-page' : ''}`}>
      {/* ---- full-width header (also the window drag region in the frameless build) ---- */}
      <header className="topbar" data-tauri-drag-region>
        <div className="topbar-brand" data-tauri-drag-region>
          <button className="brand-btn" onClick={() => setView('dashboard')} title="Home">
            <img src={logoUrl} className="topbar-logo" alt="" />
            <span className="brand-name">Mythera</span>
          </button>
          {upd?.current && <span className="ver-pill">v{upd.current}</span>}
        </div>
        <div className="topbar-spacer" data-tauri-drag-region />
        <div className="topbar-actions">
          <span className="coins" title="Coins">
            <CoinIcon className="ic" /> {user.coins}
          </span>
          <button
            className={`user-chip${view === 'profile' ? ' active' : ''}`}
            onClick={() => setView('profile')}
            title="Profile"
          >
            <SkinFace src={user.skinUrl} size={28} className="skin-face" />
            <span className="user-name">{user.username}</span>
            <span className="dot on user-dot" />
          </button>
          <button
            className="icon-btn"
            disabled={refreshing}
            onClick={() => void refreshAll()}
            title="Refresh servers & account"
          >
            <RefreshIcon className={`ic${refreshing ? ' spin' : ''}`} />
          </button>
          <button
            className={`icon-btn${view === 'settings' ? ' active' : ''}`}
            onClick={() => setView((v) => (v === 'settings' ? 'dashboard' : 'settings'))}
            title="Settings"
          >
            <GearIcon className="ic" />
          </button>
          <button className="icon-btn" onClick={() => void logout()} title="Log out">
            <LogoutIcon className="ic" />
          </button>
          <div className="win-ctl">
            <button className="win-btn" onClick={minimizeWindow} title="Minimize" aria-label="Minimize">
              <MinimizeIcon className="ic-xs" />
            </button>
            <button className="win-btn" onClick={toggleMaximizeWindow} title="Maximize" aria-label="Maximize">
              <MaximizeIcon className="ic-xs" />
            </button>
            <button className="win-btn danger" onClick={closeWindow} title="Close" aria-label="Close">
              <CloseIcon className="ic-xs" />
            </button>
          </div>
        </div>
      </header>

      {view === 'settings' ? (
        <section className="settings">
          <div className="settings-inner">
            <div className="settings-head">
              <button className="icon-btn" onClick={() => setView('dashboard')} title="Back" aria-label="Back">
                <ArrowLeftIcon className="ic" />
              </button>
              <span className="settings-badge"><GearIcon className="ic" /></span>
              <div className="settings-titles">
                <h1 className="settings-title">Settings</h1>
                <p className="settings-sub muted">Configure the launcher and game defaults.</p>
              </div>
            </div>

            {settings ? (
              <>
                <div className="set-section">
                  <div className="set-section-head">Performance</div>
                  <div className="set-card">
                    <div className="set-row">
                      <span className="set-ic"><CpuIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">Allocated RAM</div>
                        <div className="set-desc muted">{ramGb} GB of {maxRamGb} GB</div>
                      </div>
                      <div className="set-control ram">
                        <input
                          type="range"
                          min={1}
                          max={maxRamGb}
                          step={1}
                          value={ramGb}
                          onChange={(e) => updateSettings({ ramMb: Number(e.target.value) * 1024 })}
                        />
                        <span className="ram-val">{ramGb} GB</span>
                      </div>
                    </div>
                    <div className="set-row">
                      <span className="set-ic"><GaugeIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">Performance mode</div>
                        <div className="set-desc muted">Reduce launcher animations and effects</div>
                      </div>
                      <Switch on={settings.performanceMode} onClick={() => updateSettings({ performanceMode: !settings.performanceMode })} />
                    </div>
                  </div>
                </div>

                <div className="set-section">
                  <div className="set-section-head">Game</div>
                  <div className="set-card">
                    <div className="set-row">
                      <span className="set-ic"><MonitorIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">Launch in fullscreen</div>
                        <div className="set-desc muted">Start Minecraft maximized</div>
                      </div>
                      <Switch on={settings.fullscreen} onClick={() => updateSettings({ fullscreen: !settings.fullscreen })} />
                    </div>
                    <div className="set-row">
                      <span className="set-ic"><MonitorIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">Close launcher on play</div>
                        <div className="set-desc muted">Free up memory while in game</div>
                      </div>
                      <Switch on={settings.closeOnPlay} onClick={() => updateSettings({ closeOnPlay: !settings.closeOnPlay })} />
                    </div>
                    <div className="set-row">
                      <span className="set-ic"><FolderIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">Game directory</div>
                        <div className="set-desc muted set-path">{settings.gameDir}</div>
                      </div>
                      <button className="btn ghost sm" onClick={() => void browseGameDir()}>Browse</button>
                    </div>
                  </div>
                </div>

                <div className="set-section">
                  <div className="set-section-head">General</div>
                  <div className="set-card">
                    <div className="set-row">
                      <span className="set-ic"><GearIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">Automatic updates</div>
                        <div className="set-desc muted">Keep mods and launcher up to date</div>
                      </div>
                      <Switch on={settings.autoUpdate} onClick={() => updateSettings({ autoUpdate: !settings.autoUpdate })} />
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p className="muted">Loading settings…</p>
            )}
          </div>
        </section>
      ) : view === 'profile' ? (
        <section className="profile">
          <div className="profile-inner">
            <div className="settings-head">
              <button className="icon-btn" onClick={() => setView('dashboard')} title="Back" aria-label="Back">
                <ArrowLeftIcon className="ic" />
              </button>
              <span className="settings-badge"><UsersIcon className="ic" /></span>
              <div className="settings-titles">
                <h1 className="settings-title">Profile</h1>
                <p className="settings-sub muted">Your account and Minecraft skin.</p>
              </div>
            </div>

            <div className="profile-grid">
              {/* left — account info */}
              <div className="profile-card">
                <div className="set-section-head">Account</div>
                <div className="pf-id">
                  <SkinFace src={user.skinUrl} size={52} className="skin-face" />
                  <div>
                    <div className="pf-name">{user.username}</div>
                    <div className="pf-state"><span className="dot on" /> Online</div>
                  </div>
                </div>
                <div className="pf-rows">
                  <div className="pf-row">
                    <span className="pf-k">Coins</span>
                    <span className="pf-v coins-v"><CoinIcon className="ic" /> {user.coins}</span>
                  </div>
                  <div className="pf-row">
                    <span className="pf-k">Minecraft UUID</span>
                    <span className="pf-v mono">{user.mcUuid}</span>
                  </div>
                  <div className="pf-row">
                    <span className="pf-k">Account ID</span>
                    <span className="pf-v mono">#{user.id}</span>
                  </div>
                </div>
              </div>

              {/* right — ONE panel: 3D skin preview on top, drag/drop upload below */}
              <div className="profile-card skin-card">
                <div className="skin-head">
                  <DiamondIcon className="ic-xs" /> Your skin <DiamondIcon className="ic-xs" />
                </div>
                <div className="skin-stage">
                  <SkinPreview3D src={user.skinUrl || ''} />
                  <span className="skin-rotate">Drag to rotate</span>
                </div>
                <div
                  className={`skin-drop${skinDragOver ? ' over' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setSkinDragOver(true);
                  }}
                  onDragLeave={() => setSkinDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setSkinDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void onSkinFile(f);
                  }}
                  onClick={() => skinInputRef.current?.click()}
                >
                  <span className="skin-drop-plus"><UploadIcon className="ic" /></span>
                  <div className="skin-drop-title">{skinBusy ? 'Uploading…' : 'Add skin'}</div>
                  <div className="skin-drop-sub">PNG skin format · 64×64</div>
                  <div className="skin-drop-hint">drag &amp; drop or browse</div>
                  <input
                    ref={skinInputRef}
                    type="file"
                    accept="image/png"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onSkinFile(f);
                      e.target.value = '';
                    }}
                  />
                  <button
                    className="btn sm skin-browse"
                    disabled={skinBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      skinInputRef.current?.click();
                    }}
                  >
                    <FolderIcon className="ic" /> Browse files
                  </button>
                </div>
                {skinErr && <p className="error small skin-feedback">{skinErr}</p>}
                {skinMsg && <p className="pf-ok small skin-feedback">{skinMsg}</p>}
              </div>
            </div>
          </div>
        </section>
      ) : (
       <>
      {/* ---- left sidebar: grouped server list (full height) ---- */}
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="eyebrow-line"><DiamondIcon className="ic-xs" /> Servers</span>
          <span className="online-count"><span className="dot on" />{onlineCount} online</span>
        </div>
        <div className="server-list">
          {groups.map((g) => {
            const canCollapse = COLLAPSIBLE_GROUPS.has(g.key);
            const isCollapsed = canCollapse && collapsed.has(g.key);
            return (
            <div className="srv-group" key={g.key}>
              {canCollapse ? (
                <button
                  className={`group-head toggle${isCollapsed ? ' collapsed' : ''}`}
                  onClick={() => toggleGroup(g.key)}
                  aria-expanded={!isCollapsed}
                >
                  <span className="group-label">
                    <ChevronDownIcon className="group-chev" /> {g.label}
                  </span>
                  <span className="group-count">{g.items.length}</span>
                </button>
              ) : (
                <div className="group-head">
                  <span className="group-label">{g.label}</span>
                  <span className="group-count">{g.items.length}</span>
                </div>
              )}
              {!isCollapsed && g.items.map((s) => {
                const st = statuses[s.id];
                const sub = s.description?.trim() || SERVER_TYPE_LABEL[s.serverType ?? ''] || 'Minecraft server';
                return (
                  <button
                    key={s.id}
                    className={`srv-item${selected === s.id ? ' active' : ''}`}
                    onClick={() => setSelected(s.id)}
                  >
                    <span className="srv-thumb" style={s.iconUrl ? { backgroundImage: `url("${s.iconUrl}")` } : undefined}>
                      {!s.iconUrl && <span className="srv-thumb-ph">{s.name.slice(0, 1)}</span>}
                    </span>
                    <span className="srv-body">
                      <span className="srv-top">
                        <span className="srv-name">{s.name}</span>
                        <span className={`srv-online${st?.running ? ' on' : ''}`}>
                          <span className={st?.running ? 'dot on' : 'dot off'} />
                          {st?.running ? st.online : '–'}
                        </span>
                      </span>
                      <span className="srv-sub">{sub}</span>
                      <span className="srv-tags">
                        {s.mcVersion && <span className="tag">{s.mcVersion}</span>}
                        <span className={`tag mode${s.pvp === false ? ' pve' : ' pvp'}`}>{modeLabel(s)}</span>
                      </span>
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      className={`srv-fav${s.isFavorite ? ' on' : ''}`}
                      title={s.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleFavorite(s.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          void toggleFavorite(s.id);
                        }
                      }}
                    >
                      {s.isFavorite ? <StarIcon /> : <StarOutlineIcon />}
                    </span>
                    {runningId === s.id && <span className="srv-run" />}
                  </button>
                );
              })}
            </div>
            );
          })}
          {servers.length === 0 && (
            <div className="empty">
              <img src={logoUrl} className="empty-ic" alt="" />
              <p className="muted">No servers available yet.</p>
            </div>
          )}
        </div>
      </aside>

      {/* ---- main content ---- */}
      <main className="main">
        {error && <p className="error">{error}</p>}

        {upd?.updateAvailable && !upd.mustUpdate && (
          <div className="update-banner">
            <span>Launcher update available: v{upd.current} → v{upd.latest}.</span>
            {updating ? (
              <span className="muted small">{updPct === null ? 'Updating…' : `Downloading ${updPct}%`}</span>
            ) : (
              <button className="btn sm" onClick={() => void doUpdate()}>
                Update
              </button>
            )}
            {updErr && <span className="error small">{updErr}</span>}
          </div>
        )}

        {sel && (
          <>
            <span className="eyebrow-line accent"><DiamondIcon className="ic-xs" /> {heroEyebrow(sel)}</span>

            {/* hero */}
            <section className="hero" style={{ '--cover': sel.iconUrl ? `url("${sel.iconUrl}")` : 'none' } as CSSProperties}>
              <div className="hero-cover" />
              <div className="hero-shade" />
              <div className="hero-content">
                <h1 className="hero-title">
                  {titleHead && <span className="th-head">{titleHead}</span>}
                  <span className="th-tail">{titleTail}</span>
                </h1>
                {heroDesc.tagline && <p className="hero-tagline">{heroDesc.tagline}</p>}
                {heroDesc.body && <p className="hero-body">{heroDesc.body}</p>}
                {blocked ? (
                  <span className={`hero-lock ${blocked.kind}`}>
                    <span className={`dot${blocked.kind === 'offline' ? ' off' : ''}`} />
                    {blocked.label}
                  </span>
                ) : (
                  <button className="btn lg hero-play" disabled={ctaDisabled} onClick={onCta}>
                    {selBusy ? (
                      selInstalled ? 'Working…' : 'Downloading…'
                    ) : selInstalled ? (
                      <><PlayIcon className="ic" /> Play</>
                    ) : (
                      <><DownloadIcon className="ic" /> Download</>
                    )}
                  </button>
                )}
              </div>
            </section>

            {/* stat tiles — REAL data only */}
            <section className="stats">
              <div className="stat">
                <span className="stat-ic"><CubeIcon className="ic" /></span>
                <span className="stat-label">Version</span>
                <span className="stat-value">{sel.mcVersion || '—'}</span>
                <span className="stat-sub">Minecraft</span>
              </div>
              <div className="stat">
                <span className="stat-ic"><ModeIcon className="ic" /></span>
                <span className="stat-label">Type</span>
                <span className="stat-value">{SERVER_TYPE_LABEL[sel.serverType ?? ''] || '—'}</span>
                <span className="stat-sub">Game type</span>
              </div>
              <div className="stat">
                <span className="stat-ic"><SwordsIcon className="ic" /></span>
                <span className="stat-label">Mode</span>
                <span className="stat-value">{modeLabel(sel)}</span>
                <span className="stat-sub">{sel.pvp === false ? 'Player vs environment' : 'Player vs player'}</span>
              </div>
            </section>

            {/* players online — real counts + (when advertised) real player faces */}
            <section className="players">
              <div className="players-head">
                <span className="eyebrow-line"><UsersIcon className="ic-xs" /> Players online</span>
                <span className="players-count">
                  {curOnline} <span className="muted">/ {maxOnline || '—'}</span>
                </span>
              </div>
              <div className="players-bar">
                <div className="players-fill" style={{ width: `${barPct}%` }} />
              </div>
              <div className="faces" ref={setFacesEl}>
                {facesShown.length > 0 ? (
                  <>
                    {facesShown.map((p, i) => (
                      <span className="face" key={`${p.id || p.name}-${i}`} title={p.name}>
                        <SkinFace src={skinUrlFor(p)} size={34} className="skin-face" />
                      </span>
                    ))}
                    {facesExtra > 0 && <span className="face-more">+{facesExtra}</span>}
                  </>
                ) : (
                  <span className="muted small players-empty">
                    {selStatus?.running ? 'No player list advertised by this server.' : 'Server is offline.'}
                  </span>
                )}
              </div>
            </section>
          </>
        )}
      </main>

      {/* ---- bottom launch bar (under the main column) ---- */}
      {sel && (
        <footer className={`launchbar${selBusy ? ' busy' : ''}`}>
          {selBusy ? (
            // Active download/verify → the whole bar becomes a full-width progress meter, filled to the exact %.
            <div className="lb-downloading">
              <span className="lb-cover">
                {sel.iconUrl ? <img src={sel.iconUrl} alt="" /> : <span className="cover-ph">{sel.name.slice(0, 1)}</span>}
              </span>
              <div className="lb-dl">
                <div className="lb-dl-head">
                  <span className="lb-dl-name">
                    {sel.name}{' '}
                    <span className="muted">— {selProgress ? PHASE_LABEL[selProgress.phase] ?? 'Working' : selInstalled ? 'Verifying' : 'Downloading'}</span>
                  </span>
                  <span className="lb-dl-pct">{pct === null ? 'Working…' : `${pct}%`}</span>
                </div>
                <div className="pbar lg">
                  <div className={`pfill${pct === null ? ' indet' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
                </div>
                <span className="lb-dl-sub muted small">
                  {selStatusMsg}
                  {selProgress?.total ? ` · ${selProgress.done}/${selProgress.total} files` : ''}
                  {selProgress?.file ? ` · ${selProgress.file}` : ''}
                  {lastLog ? ` · ${lastLog}` : ''}
                </span>
              </div>
              <button className="cancel-btn" onClick={() => void cancelDownload(sel.id)} title="Cancel download">
                <CloseIcon className="ic" /> Cancel
              </button>
            </div>
          ) : (
            <>
              <div className="lb-left">
                <span className="lb-cover">
                  {sel.iconUrl ? <img src={sel.iconUrl} alt="" /> : <span className="cover-ph">{sel.name.slice(0, 1)}</span>}
                </span>
                <div className="lb-info">
                  <h3>
                    {sel.name} <span className="muted">({modeLabel(sel)})</span>
                  </h3>
                  <p className="lb-status">
                    <span className={`dot${selStatus?.running ? ' on' : ' off'}`} />
                    {selComingSoon
                      ? 'Coming soon — this server isn’t open yet.'
                      : selLocked
                        ? 'In development — only whitelisted players can join.'
                        : selRunning
                          ? 'Running — game launched.'
                          : selInstalled && selOffline
                            ? 'Server looks offline — you can still try to launch.'
                            : selStatusMsg || (selInstalled ? 'Ready to play · All files up to date' : 'Not downloaded yet')}
                  </p>
                </div>
              </div>

              <div className="lb-right">
                {selRunning ? (
                  <span className="state-btn running"><span className="dot on" /> Running</span>
                ) : blocked ? (
                  <span className={`state-btn ${blocked.kind}`}>
                    <span className={`dot${blocked.kind === 'offline' ? ' off' : ''}`} />
                    {blocked.label}
                  </span>
                ) : (
                  <div className="launch-wrap" ref={menuRef}>
                    {menuOpen && (
                      <div className="dropup" role="menu">
                        <button className="dropup-item" disabled={secondaryDisabled} onClick={() => void reinstall(sel.id)}>
                          <DownloadIcon className="ic" /> Reinstall
                          <span className="dropup-hint">re-download every file</span>
                        </button>
                        <button className="dropup-item" disabled={secondaryDisabled} onClick={() => void verify(sel.id)}>
                          <CheckIcon className="ic" /> Verify files
                          <span className="dropup-hint">check &amp; repair install</span>
                        </button>
                      </div>
                    )}
                    <button className="launch-btn" disabled={ctaDisabled} onClick={onCta}>
                      <span className="launch-main">{selInstalled ? 'LAUNCH' : 'DOWNLOAD'}</span>
                      <span className="launch-ic">{selInstalled ? <PlayIcon className="ic" /> : <DownloadIcon className="ic" />}</span>
                    </button>
                    <button
                      className={`launch-caret${menuOpen ? ' open' : ''}`}
                      disabled={secondaryDisabled}
                      title="More actions"
                      aria-label="More actions"
                      onClick={() => setMenuOpen((o) => !o)}
                    >
                      <ChevronDownIcon className="ic-xs" />
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </footer>
      )}
        </>
      )}
    </div>
  );
}
