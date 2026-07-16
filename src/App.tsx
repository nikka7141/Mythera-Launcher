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
  TrashIcon,
  UploadIcon,
  UsersIcon,
} from './icons';
import { SkinFace } from './skin-face';
import { SkinPreview3D } from './skin-preview-3d';
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from './window-controls';
import { useI18n, LangToggle, type TFunc } from './i18n';

/* ---------- display helpers (all derived from REAL server fields) ---------- */
const SERVER_TYPES = ['survival', 'minigame', 'roleplay'];
// Localised server-type label (empty when the type is unknown/absent).
const serverTypeLabel = (type: string | undefined, t: TFunc): string =>
  type && SERVER_TYPES.includes(type) ? t(`serverType.${type}`) : '';
// Combat mode from the server's server.properties `pvp` flag (set in the admin Properties editor). PvE/PvP
// are universal gaming terms — left untranslated.
const modeLabel = (s: McServer): string => (s.pvp === false ? 'PvE' : 'PvP');
// Only Featured / In-development groups can be collapsed in the sidebar (Favorites + Public stay open).
const COLLAPSIBLE_GROUPS = new Set(['featured', 'in_development']);
// Player-face sizing (must match .face/.faces in index.css) — drives the responsive "fit as many as fit".
const FACE_W = 36;
const FACE_GAP = 8;
const CHIP_W = 58;
// Every phase the Rust side can report, in the order they actually run: scan/download/cleanup/done cover
// the mod-jar delta sync (sync.rs); libraries/assets/java/forge cover the base client install that used
// to run silently in the background after sync hit "done" (prepare_instance in commands.rs) — that gap
// was the launcher looking frozen at 100% while asset objects and the JRE were still downloading.
const PHASE_ORDER = ['scan', 'download', 'cleanup', 'done', 'libraries', 'assets', 'java', 'forge'] as const;
// Rough share of total install time each phase takes, summing to 100 — asset objects dominate (there can
// be thousands), the mod-jar "download" phase matters most on updates, "forge"/"java" are coarse
// start/end ticks (no finer-grained progress available from the installer subprocess / single archive).
const PHASE_WEIGHTS: Record<string, number> = {
  scan: 2,
  download: 20,
  cleanup: 3,
  done: 0,
  libraries: 10,
  assets: 55,
  java: 8,
  forge: 2,
};
// Phases whose done/total count discrete files — safe to show as "N/M files". "java" reports raw bytes
// and "forge" is just a 0/1-1/1 start/end tick, so both would read as nonsense in that format.
const FILE_COUNT_PHASES = new Set(['scan', 'download', 'cleanup', 'libraries', 'assets']);
// Localised label for a sync phase shown above the full-width download bar (falls back to "Working").
const phaseLabel = (phase: string, t: TFunc): string =>
  (PHASE_ORDER as readonly string[]).includes(phase) ? t(`phase.${phase}`) : t('lb.working');
// Weighted overall percentage across ALL install phases (not just the current one), so e.g. finishing the
// 37/37 mod-jar sync no longer reads as "100%" while libraries/assets/Java still have to download.
function overallPct(p: McSyncProgress | null): number | null {
  if (!p) return null;
  const idx = (PHASE_ORDER as readonly string[]).indexOf(p.phase);
  if (idx === -1) return null;
  let acc = 0;
  for (let i = 0; i < idx; i++) acc += PHASE_WEIGHTS[PHASE_ORDER[i]];
  const w = PHASE_WEIGHTS[PHASE_ORDER[idx]];
  if (w > 0) {
    if (p.total > 0) acc += w * Math.min(1, p.done / p.total);
    // No Content-Length on this download (total=0) — nudge forward instead of stalling in place.
    else if (p.done > 0) acc += w * 0.5;
  }
  return Math.min(100, Math.round(acc));
}
function heroEyebrow(s: McServer, t: TFunc): string {
  if (s.statusMode === 'featured') return t('hero.eyebrow.featured');
  if (s.statusMode === 'in_development') return t('hero.eyebrow.inDev');
  return t('hero.eyebrow.selected');
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

/* ---------- Roleplay progression ("შენი პროგრესი" / Your progress) ---------- */
type RpField = NonNullable<McServer['rp']>['fields'][number];
type RpStat = string | number | boolean | null;

// field.icon key -> a lightweight glyph. Emoji keeps the panel dependency-free while covering the
// roleplay-flavoured icon set (crown/castle/flag/…); unknown/absent keys fall back to a neutral diamond.
const RP_ICONS: Record<string, string> = {
  crown: '👑',
  coins: '🪙',
  castle: '🏰',
  flag: '🏳️',
  sword: '⚔️',
  star: '⭐',
  shield: '🛡️',
  chain: '⛓️',
  scroll: '📜',
  target: '🎯',
};
const rpIcon = (icon?: string): string => (icon ? RP_ICONS[icon] : undefined) ?? '◆';

// Strip Minecraft colour codes (§x / &x) that can ride along in a placeholder value (e.g. an Imperia rank
// name like "§7გლეხი") — the raw code shouldn't show; the badge colour comes from roleBadgeTone instead.
const stripMc = (s: string) => s.replace(/[§&][0-9a-fk-orA-FK-OR]/g, '').trim();

// Role/status badge colour. The value may arrive as a Georgian label OR a raw latin id, so match both
// case-insensitively; anything unrecognised gets the neutral pill.
function roleBadgeTone(raw: string): 'gold' | 'purple' | 'green' | 'gray' | 'neutral' {
  const v = raw.trim().toLowerCase();
  if (v === 'მეფე' || v === 'mepe' || v === 'king') return 'gold';
  if (v === 'აზნაური' || v === 'aznauri' || v === 'noble') return 'purple';
  if (v === 'გლეხი' || v === 'glekhi' || v === 'peasant') return 'green';
  if (v === 'ყმა' || v === 'yma' || v === 'serf') return 'gray';
  return 'neutral';
}

/** Truthiness for showIf:'truthy' — a value counts as present unless it's null/''/'-'/'false'/'0'. */
function isTruthyStat(v: RpStat | undefined): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '-' && s !== 'false' && s !== '0';
}

/** Integer with thousands separators (money/number formats). Non-numeric values pass through as-is. */
function fmtNumber(v: RpStat | undefined): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return v == null ? '—' : String(v);
  return Math.trunc(n).toLocaleString('en-US');
}

/** Apply a field's showIf rule against its resolved value. */
function rpShouldShow(field: RpField, value: RpStat | undefined): boolean {
  const rule = field.showIf ?? 'always';
  if (rule === 'always') return true;
  if (rule === 'nonzero') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0;
  }
  return isTruthyStat(value); // 'truthy'
}

/** Render a single stat value according to its format (money/number/badge/text). */
function RpValue({ field, value }: { field: RpField; value: RpStat }) {
  const fmt = field.format ?? 'text';
  if (fmt === 'money') {
    return (
      <span className="rp-money">
        {fmtNumber(value)}
        <CoinIcon className="rp-coin" />
      </span>
    );
  }
  if (fmt === 'number') return <>{fmtNumber(value)}</>;
  if (fmt === 'badge') {
    if (typeof value === 'boolean') {
      return <span className={`rp-badge ${value ? 'green' : 'neutral'}`}>{value ? '✔' : '—'}</span>;
    }
    const text = value == null || value === '' ? '—' : stripMc(String(value));
    return <span className={`rp-badge ${roleBadgeTone(text)}`}>{text}</span>;
  }
  return <>{value == null || value === '' ? '—' : stripMc(String(value))}</>;
}

/**
 * "Your progress" panel — per-user roleplay stats for the selected server. `fields` is the admin-curated
 * display config (from `sel.rp.fields`); the values come from the JWT-guarded /me/stats endpoint. Degrades
 * gracefully when the player has no data yet or isn't logged in (stats === null).
 */
function RpProgressPanel({ serverId, fields }: { serverId: number; fields: RpField[] }) {
  const mc = window.mc;
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<Record<string, RpStat> | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setStats(null);
    mc.playerStats(serverId)
      .then((res) => {
        if (alive) setStats(res?.stats ?? null);
      })
      .catch(() => {
        if (alive) setStats(null); // not logged in / offline → treat as "no data yet"
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [serverId, mc]);

  const tiles = stats ? fields.filter((f) => rpShouldShow(f, stats[f.key])) : [];

  return (
    <section className="rp">
      <div className="rp-head">
        <span className="eyebrow-line accent">
          <StarIcon className="ic-xs" /> {t('rp.title')}
        </span>
      </div>
      {loading ? (
        <p className="muted small rp-empty">{t('rp.loading')}</p>
      ) : stats == null || tiles.length === 0 ? (
        <p className="muted small rp-empty">{t('rp.empty')}</p>
      ) : (
        <div className="rp-grid">
          {tiles.map((f) => (
            <div className="stat" key={f.key}>
              <span className="stat-ic rp-ic" aria-hidden>
                {rpIcon(f.icon)}
              </span>
              <span className="stat-label">{f.label}</span>
              <span className="stat-value">
                <RpValue field={f} value={stats[f.key]} />
              </span>
              {f.suffix ? <span className="stat-sub">{f.suffix}</span> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const TASKS_PREVIEW_COUNT = 3;

function TaskProgressBar({ value, target }: { value: number; target: number }) {
  const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;
  return (
    <div className="task-bar">
      <div className="task-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function TaskRow({ tk }: { tk: McServerTask }) {
  const { t } = useI18n();
  return (
    <div className={`task-row${tk.completed ? ' done' : ''}`}>
      <div className="task-row-head">
        <span className="task-name">{tk.name}</span>
        {tk.completed && <span className="task-done-badge">{t('tasks.completed')}</span>}
      </div>
      <p className="muted small task-desc">{tk.description}</p>
      <TaskProgressBar value={tk.progressValue} target={tk.targetValue} />
      <div className="task-row-foot">
        <span className="muted small">
          {Math.min(tk.progressValue, tk.targetValue).toLocaleString()} / {tk.targetValue.toLocaleString()}
        </span>
        <span className="task-reward">{tk.rewardLabel}</span>
      </div>
    </div>
  );
}

/** Tasks/quests for the selected server — a compact preview that expands to the full daily/weekly/custom list. */
function TasksPanel({ serverId }: { serverId: number }) {
  const mc = window.mc;
  const { t } = useI18n();
  const [tasks, setTasks] = useState<McServerTask[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    setTasks(null);
    setExpanded(false);
    mc.serverTasks(serverId)
      .then((r) => {
        if (alive) setTasks(r);
      })
      .catch(() => {
        if (alive) setTasks([]);
      });
    return () => {
      alive = false;
    };
  }, [serverId, mc]);

  if (!tasks || tasks.length === 0) return null;

  const daily = tasks.filter((x) => x.scheduleType === 'daily');
  const weekly = tasks.filter((x) => x.scheduleType === 'weekly');
  const custom = tasks.filter((x) => x.scheduleType === 'custom');

  return (
    <section className="rp">
      <div className="rp-head">
        <span className="eyebrow-line accent">
          <StarIcon className="ic-xs" /> {t('tasks.title')}
        </span>
        {tasks.length > TASKS_PREVIEW_COUNT && (
          <button className="task-more-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? t('tasks.showLess') : t('tasks.seeMore')}
          </button>
        )}
      </div>
      {expanded ? (
        <div className="task-groups">
          {daily.length > 0 && (
            <div className="task-group">
              <span className="task-group-label">{t('tasks.daily')}</span>
              {daily.map((tk) => (
                <TaskRow key={tk.id} tk={tk} />
              ))}
            </div>
          )}
          {weekly.length > 0 && (
            <div className="task-group">
              <span className="task-group-label">{t('tasks.weekly')}</span>
              {weekly.map((tk) => (
                <TaskRow key={tk.id} tk={tk} />
              ))}
            </div>
          )}
          {custom.length > 0 && (
            <div className="task-group">
              <span className="task-group-label">{t('tasks.custom')}</span>
              {custom.map((tk) => (
                <TaskRow key={tk.id} tk={tk} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="task-groups">
          {tasks.slice(0, TASKS_PREVIEW_COUNT).map((tk) => (
            <TaskRow key={tk.id} tk={tk} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function App() {
  const mc = window.mc;
  const { t } = useI18n();
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
      setSrvStatus(p.serverId, t('status.gameExited', { code: p.code ?? '?' }));
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
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : t('auth.err.loginFailed'));
    }
  }

  async function register(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      setError(t('auth.err.username'));
      return;
    }
    if (password.length < 8 || !/\D/.test(password)) {
      setError(t('auth.err.password'));
      return;
    }
    if (password !== confirm) {
      setError(t('auth.err.mismatch'));
      return;
    }
    try {
      await afterAuth(await mc.register({ username, password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : t('auth.err.registerFailed'));
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
        setError(t('auth.err.noAccounts'));
        return;
      }
      setRecAccounts(res.accounts.map((a) => a.username));
      setRecStep('pick');
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : t('auth.err.lookupFailed'));
    }
  }

  // Recovery step 3: set the new password for the picked account.
  async function recoverReset(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8 || !/\D/.test(password)) {
      setError(t('auth.err.password'));
      return;
    }
    if (password !== confirm) {
      setError(t('auth.err.mismatch'));
      return;
    }
    try {
      await mc.recoverReset({ username: recPicked, newPassword: password });
      setRecStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : t('auth.err.resetFailed'));
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
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : t('common.err.refreshFailed'));
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
        setError(e instanceof Error ? e.message : typeof e === 'string' ? e : t('set.err.save')),
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
      setError(e instanceof Error ? e.message : typeof e === 'string' ? e : t('set.err.folder'));
    }
  }

  // Validate + upload a Minecraft skin (same rules the backend enforces: PNG, 64×64 or 64×32, ≤256 KB).
  async function onSkinFile(file: File) {
    setSkinErr('');
    setSkinMsg('');
    if (file.size > 262144) {
      setSkinErr(t('prof.skin.tooBig'));
      return;
    }
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) {
      setSkinErr(t('prof.skin.notPng'));
      return;
    }
    const dv = new DataView(buf);
    const w = dv.getUint32(16);
    const h = dv.getUint32(20);
    if (!(w === 64 && (h === 64 || h === 32))) {
      setSkinErr(t('prof.skin.badSize', { w, h }));
      return;
    }
    setSkinBusy(true);
    try {
      await mc.uploadSkin(Array.from(bytes));
      setUser(await mc.refreshUser());
      setSkinMsg(t('prof.skin.updated'));
    } catch (e) {
      setSkinErr(e instanceof Error ? e.message : typeof e === 'string' ? e : t('prof.skin.failed'));
    } finally {
      setSkinBusy(false);
    }
  }

  // Delete the uploaded skin and revert in-game to the server's configured default.
  async function onSkinClear() {
    if (!window.confirm(t('prof.skin.removeConfirm'))) return;
    setSkinErr('');
    setSkinMsg('');
    setSkinBusy(true);
    try {
      await mc.clearSkin();
      setUser(await mc.refreshUser());
      setSkinMsg(t('prof.skin.removed'));
    } catch (e) {
      setSkinErr(e instanceof Error ? e.message : typeof e === 'string' ? e : t('prof.skin.failed'));
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
      setUpdErr(err instanceof Error ? err.message : typeof err === 'string' ? err : t('update.failed'));
      setUpdating(false);
    }
  }

  // A canceled op rejects too — show a calm "Canceled" status instead of a red error.
  function handleOpError(id: number, err: unknown, fallback: string) {
    setProgress(null);
    if (canceledRef.current.delete(id)) {
      setSrvStatus(id, t('status.canceled'));
    } else {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : fallback);
      setSrvStatus(id, '');
    }
  }

  async function cancelDownload(id: number) {
    canceledRef.current.add(id);
    setSrvStatus(id, t('status.canceling'));
    await mc.cancelSync(id).catch(() => undefined);
  }

  async function download(id: number) {
    setError('');
    setBusy(id);
    try {
      setSrvStatus(id, t('status.downloadingFiles'));
      await mc.install(id);
      setProgress(null);
      setInstalled((m) => ({ ...m, [id]: true }));
      setSrvStatus(id, t('status.downloaded'));
    } catch (err) {
      handleOpError(id, err, t('status.err.download'));
    } finally {
      setBusy(null);
    }
  }

  async function reinstall(id: number) {
    setMenuOpen(false);
    setError('');
    setBusy(id);
    try {
      setSrvStatus(id, t('status.reinstalling'));
      await mc.install(id);
      setProgress(null);
      setInstalled((m) => ({ ...m, [id]: true }));
      setSrvStatus(id, t('status.reinstalled'));
    } catch (err) {
      handleOpError(id, err, t('status.err.reinstall'));
    } finally {
      setBusy(null);
    }
  }

  async function verify(id: number) {
    setMenuOpen(false);
    setError('');
    setBusy(id);
    try {
      setSrvStatus(id, t('status.verifying'));
      const r = await mc.sync(id);
      setProgress(null);
      setInstalled((m) => ({ ...m, [id]: true }));
      setSrvStatus(id, t('status.verified', { d: r.downloaded, del: r.deleted, u: r.unchanged }));
    } catch (err) {
      handleOpError(id, err, t('status.err.verify'));
    } finally {
      setBusy(null);
    }
  }

  async function play(id: number) {
    setError('');
    setBusy(id);
    try {
      setSrvStatus(id, t('status.verifying'));
      const r = await mc.sync(id);
      setProgress(null);
      setSrvStatus(id, t('status.synced', { d: r.downloaded, del: r.deleted }));
      await mc.launch(id);
      setInstalled((m) => ({ ...m, [id]: true }));
      setRunningId(id);
      setSrvStatus(id, t('status.launched'));
      if (settings?.closeOnPlay) minimizeWindow();
    } catch (err) {
      handleOpError(id, err, t('status.err.launch'));
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
      { key: 'fav', label: t('group.fav'), items: fav },
      { key: 'published', label: t('group.published'), items: byMode('published') },
      { key: 'featured', label: t('group.featured'), items: byMode('featured') },
      { key: 'in_development', label: t('group.inDev'), items: byMode('in_development') },
    ].filter((g) => g.items.length > 0);
  }, [servers, t]);

  // Hard version gate: below minSupported the launcher is blocked until it updates.
  if (upd?.mustUpdate) {
    return (
      <main className="app">
        <div className="update-modal">
          <LangToggle className="lang-corner" />
          <h1>{t('update.required.title')}</h1>
          <p className="muted">{t('update.required.body', { current: upd.current ?? '', latest: upd.latest ?? '' })}</p>
          {updErr && <p className="error">{updErr}</p>}
          {updating ? (
            <>
              <div className="pbar">
                <div className={`pfill${updPct === null ? ' indet' : ''}`} style={updPct === null ? undefined : { width: `${updPct}%` }} />
              </div>
              <p className="muted small">{updPct === null ? t('update.starting') : t('update.downloading', { pct: updPct })}</p>
            </>
          ) : (
            <button className="btn lg" onClick={() => void doUpdate()}>
              {t('update.now')}
            </button>
          )}
          {!upd.packaged && <p className="muted small">{t('update.devBuild')}</p>}
        </div>
      </main>
    );
  }

  if (!user) {
    const onSubmit =
      authMode === 'login' ? login : authMode === 'register' ? register : recStep === 'reset' ? recoverReset : (e: FormEvent) => e.preventDefault();
    const title =
      authMode === 'login' ? t('auth.title.login') : authMode === 'register' ? t('auth.title.register') : t('auth.title.recover');
    const sub =
      authMode === 'login'
        ? t('auth.sub.login')
        : authMode === 'register'
          ? t('auth.sub.register')
          : recStep === 'lookup'
            ? t('auth.sub.recover.lookup')
            : recStep === 'pick'
              ? t('auth.sub.recover.pick')
              : recStep === 'reset'
                ? t('auth.sub.recover.reset', { name: recPicked })
                : t('auth.sub.recover.done');
    return (
      <main className="app">
        <form className="login" onSubmit={onSubmit}>
          <LangToggle className="lang-corner" />
          <span className="eyebrow"><img src={logoUrl} className="logo-sm" alt="" /> Mythera</span>
          <h1>{title}</h1>
          <p className="muted small login-sub">{sub}</p>
          {error && <p className="error">{error}</p>}

          {authMode !== 'recover' && (
            <>
              <input placeholder={t('auth.ph.username')} value={username} onChange={(e) => setUsername(e.target.value)} required />
              <input
                type="password"
                placeholder={t('auth.ph.password')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {authMode === 'register' && (
                <input
                  type="password"
                  placeholder={t('auth.ph.repeat')}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              )}
              <button className="btn lg">{authMode === 'login' ? t('auth.btn.login') : t('auth.btn.register')}</button>
              {authMode === 'login' && (
                <button type="button" className="linklike login-forgot" onClick={() => switchMode('recover')}>
                  {t('auth.btn.forgot')}
                </button>
              )}
            </>
          )}

          {authMode === 'recover' && recStep === 'lookup' && (
            <button type="button" className="btn lg" onClick={() => void recoverFind()}>
              {t('auth.btn.find')}
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
                  <span className="muted small">{t('auth.btn.recover')}</span>
                </button>
              ))}
            </div>
          )}

          {authMode === 'recover' && recStep === 'reset' && (
            <>
              <input
                type="password"
                placeholder={t('auth.ph.newPassword')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
              />
              <input
                type="password"
                placeholder={t('auth.ph.repeat')}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
              <button className="btn lg">{t('auth.btn.setPassword')}</button>
              <button type="button" className="linklike" onClick={() => setRecStep('pick')}>
                {t('auth.btn.chooseOther')}
              </button>
            </>
          )}

          {authMode === 'recover' && recStep === 'done' && (
            <>
              <p className="muted small">{t('auth.done.msg', { name: recPicked })}</p>
              <button type="button" className="btn lg" onClick={() => switchMode('login')}>
                {t('auth.btn.goLogin')}
              </button>
            </>
          )}

          <p className="muted small login-switch">
            {authMode === 'login' && (
              <>
                {t('auth.switch.noAccount')}{' '}
                <button type="button" className="linklike" onClick={() => switchMode('register')}>
                  {t('auth.btn.createOne')}
                </button>
              </>
            )}
            {authMode === 'register' && (
              <>
                {t('auth.switch.haveAccount')}{' '}
                <button type="button" className="linklike" onClick={() => switchMode('login')}>
                  {t('auth.btn.login')}
                </button>
              </>
            )}
            {authMode === 'recover' && (
              <>
                {t('auth.switch.remembered')}{' '}
                <button type="button" className="linklike" onClick={() => switchMode('login')}>
                  {t('auth.btn.backLogin')}
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
  const selRestarting = selStatus?.restarting === true; // just (re)started, not answering yet
  const selComingSoon = !!sel && sel.statusMode === 'featured';
  const selLocked = selComingSoon || (!!sel && sel.statusMode === 'in_development' && !sel.isWhitelisted);
  const selInstalled = sel ? installed[sel.id] : false;
  const selRunning = sel != null && runningId === sel.id;
  const otherRunning = runningId !== null && runningId !== selected;
  const selBusy = sel != null && busy === sel.id;
  const selStatusMsg = sel ? statusMap[sel.id] ?? '' : '';
  const selProgress = progress && sel && progress.serverId === sel.id ? progress : null;
  const pct = overallPct(selProgress);
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
      ? { kind: 'soon', label: t('blocked.soon') }
      : sel.statusMode === 'in_development' && !sel.isWhitelisted
        ? { kind: 'dev', label: t('blocked.dev') }
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
          <button className="brand-btn" onClick={() => setView('dashboard')} title={t('hdr.home')}>
            <img src={logoUrl} className="topbar-logo" alt="" />
            <span className="brand-name">Mythera</span>
          </button>
          {upd?.current && <span className="ver-pill">v{upd.current}</span>}
        </div>
        <div className="topbar-spacer" data-tauri-drag-region />
        <div className="topbar-actions">
          <span className="coins" title={t('hdr.coins')}>
            <CoinIcon className="ic" /> {user.coins}
          </span>
          <button
            className={`user-chip${view === 'profile' ? ' active' : ''}`}
            onClick={() => setView('profile')}
            title={t('hdr.profile')}
          >
            <SkinFace src={user.skinUrl} size={28} className="skin-face" />
            <span className="user-name">{user.username}</span>
            <span className="dot on user-dot" />
          </button>
          <LangToggle />
          <button
            className="icon-btn"
            disabled={refreshing}
            onClick={() => void refreshAll()}
            title={t('hdr.refresh')}
          >
            <RefreshIcon className={`ic${refreshing ? ' spin' : ''}`} />
          </button>
          <button
            className={`icon-btn${view === 'settings' ? ' active' : ''}`}
            onClick={() => setView((v) => (v === 'settings' ? 'dashboard' : 'settings'))}
            title={t('hdr.settings')}
          >
            <GearIcon className="ic" />
          </button>
          <button className="icon-btn" onClick={() => void logout()} title={t('hdr.logout')}>
            <LogoutIcon className="ic" />
          </button>
          <div className="win-ctl">
            <button className="win-btn" onClick={minimizeWindow} title={t('hdr.minimize')} aria-label={t('hdr.minimize')}>
              <MinimizeIcon className="ic-xs" />
            </button>
            <button className="win-btn" onClick={toggleMaximizeWindow} title={t('hdr.maximize')} aria-label={t('hdr.maximize')}>
              <MaximizeIcon className="ic-xs" />
            </button>
            <button className="win-btn danger" onClick={closeWindow} title={t('hdr.close')} aria-label={t('hdr.close')}>
              <CloseIcon className="ic-xs" />
            </button>
          </div>
        </div>
      </header>

      {view === 'settings' ? (
        <section className="settings">
          <div className="settings-inner">
            <div className="settings-head">
              <button className="icon-btn" onClick={() => setView('dashboard')} title={t('common.back')} aria-label={t('common.back')}>
                <ArrowLeftIcon className="ic" />
              </button>
              <span className="settings-badge"><GearIcon className="ic" /></span>
              <div className="settings-titles">
                <h1 className="settings-title">{t('set.title')}</h1>
                <p className="settings-sub muted">{t('set.sub')}</p>
              </div>
            </div>

            {settings ? (
              <>
                <div className="set-section">
                  <div className="set-section-head">{t('set.sec.performance')}</div>
                  <div className="set-card">
                    <div className="set-row">
                      <span className="set-ic"><CpuIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">{t('set.ram.name')}</div>
                        <div className="set-desc muted">{t('set.ram.desc', { ram: ramGb, max: maxRamGb })}</div>
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
                        <div className="set-name">{t('set.perf.name')}</div>
                        <div className="set-desc muted">{t('set.perf.desc')}</div>
                      </div>
                      <Switch on={settings.performanceMode} onClick={() => updateSettings({ performanceMode: !settings.performanceMode })} />
                    </div>
                  </div>
                </div>

                <div className="set-section">
                  <div className="set-section-head">{t('set.sec.game')}</div>
                  <div className="set-card">
                    <div className="set-row">
                      <span className="set-ic"><MonitorIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">{t('set.fs.name')}</div>
                        <div className="set-desc muted">{t('set.fs.desc')}</div>
                      </div>
                      <Switch on={settings.fullscreen} onClick={() => updateSettings({ fullscreen: !settings.fullscreen })} />
                    </div>
                    <div className="set-row">
                      <span className="set-ic"><MonitorIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">{t('set.close.name')}</div>
                        <div className="set-desc muted">{t('set.close.desc')}</div>
                      </div>
                      <Switch on={settings.closeOnPlay} onClick={() => updateSettings({ closeOnPlay: !settings.closeOnPlay })} />
                    </div>
                    <div className="set-row">
                      <span className="set-ic"><FolderIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">{t('set.dir.name')}</div>
                        <div className="set-desc muted set-path">{settings.gameDir}</div>
                      </div>
                      <button className="btn ghost sm" onClick={() => void browseGameDir()}>{t('set.browse')}</button>
                    </div>
                  </div>
                </div>

                <div className="set-section">
                  <div className="set-section-head">{t('set.sec.general')}</div>
                  <div className="set-card">
                    <div className="set-row">
                      <span className="set-ic"><GearIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">{t('set.auto.name')}</div>
                        <div className="set-desc muted">{t('set.auto.desc')}</div>
                      </div>
                      <Switch on={settings.autoUpdate} onClick={() => updateSettings({ autoUpdate: !settings.autoUpdate })} />
                    </div>
                    <div className="set-row">
                      <span className="set-ic"><MonitorIcon className="ic" /></span>
                      <div className="set-text">
                        <div className="set-name">{t('set.lang.name')}</div>
                        <div className="set-desc muted">{t('set.lang.desc')}</div>
                      </div>
                      <LangToggle />
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p className="muted">{t('set.loading')}</p>
            )}
          </div>
        </section>
      ) : view === 'profile' ? (
        <section className="profile">
          <div className="profile-inner">
            <div className="settings-head">
              <button className="icon-btn" onClick={() => setView('dashboard')} title={t('common.back')} aria-label={t('common.back')}>
                <ArrowLeftIcon className="ic" />
              </button>
              <span className="settings-badge"><UsersIcon className="ic" /></span>
              <div className="settings-titles">
                <h1 className="settings-title">{t('prof.title')}</h1>
                <p className="settings-sub muted">{t('prof.sub')}</p>
              </div>
            </div>

            <div className="profile-grid">
              {/* left — account info */}
              <div className="profile-card">
                <div className="set-section-head">{t('prof.account')}</div>
                <div className="pf-id">
                  <SkinFace src={user.skinUrl} size={52} className="skin-face" />
                  <div>
                    <div className="pf-name">{user.username}</div>
                    <div className="pf-state"><span className="dot on" /> {t('prof.online')}</div>
                  </div>
                </div>
                <div className="pf-rows">
                  <div className="pf-row">
                    <span className="pf-k">{t('prof.coins')}</span>
                    <span className="pf-v coins-v"><CoinIcon className="ic" /> {user.coins}</span>
                  </div>
                  <div className="pf-row">
                    <span className="pf-k">{t('prof.uuid')}</span>
                    <span className="pf-v mono">{user.mcUuid}</span>
                  </div>
                  <div className="pf-row">
                    <span className="pf-k">{t('prof.accountId')}</span>
                    <span className="pf-v mono">#{user.id}</span>
                  </div>
                </div>
              </div>

              {/* right — ONE panel: 3D skin preview on top, drag/drop upload below */}
              <div className="profile-card skin-card">
                <div className="skin-head">
                  <DiamondIcon className="ic-xs" /> {t('prof.skin')} <DiamondIcon className="ic-xs" />
                </div>
                <div className="skin-stage">
                  <SkinPreview3D src={user.skinUrl || ''} />
                  <span className="skin-rotate">{t('prof.rotate')}</span>
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
                  <div className="skin-drop-title">{skinBusy ? t('prof.uploading') : t('prof.addSkin')}</div>
                  <div className="skin-drop-sub">{t('prof.skinFormat')}</div>
                  <div className="skin-drop-hint">{t('prof.dropHint')}</div>
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
                    <FolderIcon className="ic" /> {t('prof.browseFiles')}
                  </button>
                </div>
                {user.skinUrl && (
                  <button className="btn sm ghost skin-remove" disabled={skinBusy} onClick={() => void onSkinClear()}>
                    <TrashIcon className="ic" /> {t('prof.skin.remove')}
                  </button>
                )}
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
          <span className="eyebrow-line"><DiamondIcon className="ic-xs" /> {t('side.servers')}</span>
          <span className="online-count"><span className="dot on" />{t('side.online', { n: onlineCount })}</span>
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
                const sub = s.description?.trim() || serverTypeLabel(s.serverType, t) || t('side.serverFallback');
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
                      title={s.isFavorite ? t('side.favRemove') : t('side.favAdd')}
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
              <p className="muted">{t('side.empty')}</p>
            </div>
          )}
        </div>
      </aside>

      {/* ---- main content ---- */}
      <main className="main">
        {error && <p className="error">{error}</p>}

        {upd?.updateAvailable && !upd.mustUpdate && (
          <div className="update-banner">
            <span>{t('update.banner', { current: upd.current ?? '', latest: upd.latest ?? '' })}</span>
            {updating ? (
              <span className="muted small">{updPct === null ? t('update.updating') : t('update.downloading', { pct: updPct })}</span>
            ) : (
              <button className="btn sm" onClick={() => void doUpdate()}>
                {t('update.update')}
              </button>
            )}
            {updErr && <span className="error small">{updErr}</span>}
          </div>
        )}

        {sel && (
          <>
            <span className="eyebrow-line accent"><DiamondIcon className="ic-xs" /> {heroEyebrow(sel, t)}</span>

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
                      selInstalled ? t('cta.working') : t('cta.downloading')
                    ) : selInstalled ? (
                      <><PlayIcon className="ic" /> {t('cta.play')}</>
                    ) : (
                      <><DownloadIcon className="ic" /> {t('cta.download')}</>
                    )}
                  </button>
                )}
              </div>
            </section>

            {/* stat tiles — REAL data only */}
            <section className="stats">
              <div className="stat">
                <span className="stat-ic"><CubeIcon className="ic" /></span>
                <span className="stat-label">{t('stat.version')}</span>
                <span className="stat-value">{sel.mcVersion || '—'}</span>
                <span className="stat-sub">{t('stat.minecraft')}</span>
              </div>
              <div className="stat">
                <span className="stat-ic"><ModeIcon className="ic" /></span>
                <span className="stat-label">{t('stat.type')}</span>
                <span className="stat-value">{serverTypeLabel(sel.serverType, t) || '—'}</span>
                <span className="stat-sub">{t('stat.gameType')}</span>
              </div>
              <div className="stat">
                <span className="stat-ic"><SwordsIcon className="ic" /></span>
                <span className="stat-label">{t('stat.mode')}</span>
                <span className="stat-value">{modeLabel(sel)}</span>
                <span className="stat-sub">{sel.pvp === false ? t('stat.pve') : t('stat.pvp')}</span>
              </div>
            </section>

            {/* roleplay progression — per-user stats, only when the server opted in (rp.enabled) */}
            {sel?.rp?.enabled && <RpProgressPanel serverId={sel.id} fields={sel.rp.fields} />}

            {/* tasks / quests — hides itself when the server has none active for this player */}
            {sel && <TasksPanel serverId={sel.id} />}

            {/* players online — real counts + (when advertised) real player faces */}
            <section className="players">
              <div className="players-head">
                <span className="eyebrow-line"><UsersIcon className="ic-xs" /> {t('players.title')}</span>
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
                    {selStatus?.running
                      ? t('players.noList')
                      : selStatus?.restarting
                        ? t('players.restarting')
                        : t('players.offline')}
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
                    <span className="muted">— {selProgress ? phaseLabel(selProgress.phase, t) : selInstalled ? t('lb.verifying') : t('lb.downloading')}</span>
                  </span>
                  <span className="lb-dl-pct">{pct === null ? t('lb.workingDots') : `${pct}%`}</span>
                </div>
                <div className="pbar lg">
                  <div className={`pfill${pct === null ? ' indet' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
                </div>
                <span className="lb-dl-sub muted small">
                  {selStatusMsg}
                  {selProgress?.total && FILE_COUNT_PHASES.has(selProgress.phase)
                    ? ` · ${t('lb.files', { done: selProgress.done, total: selProgress.total })}`
                    : ''}
                  {selProgress?.file ? ` · ${selProgress.file}` : ''}
                  {lastLog ? ` · ${lastLog}` : ''}
                </span>
              </div>
              <button className="cancel-btn" onClick={() => void cancelDownload(sel.id)} title={t('lb.cancelTitle')}>
                <CloseIcon className="ic" /> {t('lb.cancel')}
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
                    <span className={`dot${selStatus?.restarting ? ' warn' : selStatus?.running ? ' on' : ' off'}`} />
                    {selComingSoon
                      ? t('lb.status.soon')
                      : selLocked
                        ? t('lb.status.dev')
                        : selRunning
                          ? t('lb.status.running')
                          : selRestarting
                            ? t('lb.status.restarting')
                            : selInstalled && selOffline
                              ? t('lb.status.offline')
                              : selStatusMsg || (selInstalled ? t('lb.status.ready') : t('lb.status.notDownloaded'))}
                  </p>
                </div>
              </div>

              <div className="lb-right">
                {selRunning ? (
                  <span className="state-btn running"><span className="dot on" /> {t('lb.running')}</span>
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
                          <DownloadIcon className="ic" /> {t('lb.reinstall')}
                          <span className="dropup-hint">{t('lb.reinstall.hint')}</span>
                        </button>
                        <button className="dropup-item" disabled={secondaryDisabled} onClick={() => void verify(sel.id)}>
                          <CheckIcon className="ic" /> {t('lb.verifyFiles')}
                          <span className="dropup-hint">{t('lb.verify.hint')}</span>
                        </button>
                      </div>
                    )}
                    <button className="launch-btn" disabled={ctaDisabled} onClick={onCta}>
                      <span className="launch-main">{selInstalled ? t('lb.launch') : t('lb.download')}</span>
                      <span className="launch-ic">{selInstalled ? <PlayIcon className="ic" /> : <DownloadIcon className="ic" />}</span>
                    </button>
                    <button
                      className={`launch-caret${menuOpen ? ' open' : ''}`}
                      disabled={secondaryDisabled}
                      title={t('lb.moreActions')}
                      aria-label={t('lb.moreActions')}
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
