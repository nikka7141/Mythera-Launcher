import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

/**
 * Lightweight i18n for the launcher. Pure client (Tauri WebView, no SSR), so the initial locale is read
 * synchronously from localStorage — no flash. Default is Georgian (`ka`); English (`en`) is the fallback
 * dictionary for any missing key. Strings interpolate {name}-style placeholders.
 */
export type Locale = 'ka' | 'en';
const STORAGE_KEY = 'mythera_lang';

const en: Record<string, string> = {
  // server type
  'serverType.survival': 'Survival',
  'serverType.minigame': 'Minigame',
  'serverType.roleplay': 'Roleplay',
  // sync phases
  'phase.scan': 'Scanning files',
  'phase.download': 'Downloading',
  'phase.cleanup': 'Cleaning up',
  'phase.done': 'Finishing',
  // hero eyebrow
  'hero.eyebrow.featured': 'Featured server',
  'hero.eyebrow.inDev': 'In development',
  'hero.eyebrow.selected': 'Selected server',
  // sidebar groups
  'group.fav': 'Favorites',
  'group.published': 'Public',
  'group.featured': 'Featured',
  'group.inDev': 'In development',
  // auth titles / subs
  'auth.title.login': 'Log in',
  'auth.title.register': 'Create account',
  'auth.title.recover': 'Recover account',
  'auth.sub.login': 'Sign in to download and play on your servers.',
  'auth.sub.register': 'Create an account to download and play on your servers.',
  'auth.sub.recover.lookup': 'No email needed — recover the account you created on this connection.',
  'auth.sub.recover.pick': 'Pick the account you want to recover.',
  'auth.sub.recover.reset': 'Set a new password for "{name}".',
  'auth.sub.recover.done': 'Password updated.',
  // auth inputs
  'auth.ph.username': 'username',
  'auth.ph.password': 'password',
  'auth.ph.repeat': 'repeat password',
  'auth.ph.newPassword': 'new password',
  // auth buttons
  'auth.btn.login': 'Log in',
  'auth.btn.register': 'Create account',
  'auth.btn.forgot': 'Forgot password?',
  'auth.btn.find': 'Find my accounts',
  'auth.btn.setPassword': 'Set new password',
  'auth.btn.chooseOther': '← Choose a different account',
  'auth.btn.goLogin': 'Go to log in',
  'auth.btn.recover': 'Recover →',
  'auth.btn.createOne': 'Create one',
  'auth.btn.backLogin': 'Back to log in',
  // auth switch prompts
  'auth.switch.noAccount': "Don't have an account?",
  'auth.switch.haveAccount': 'Already have an account?',
  'auth.switch.remembered': 'Remembered it?',
  'auth.done.msg': 'Password updated for {name}. Log in with your new password.',
  // auth errors
  'auth.err.loginFailed': 'Login failed',
  'auth.err.username': 'Username: 3–16 chars, letters/numbers/_ only.',
  'auth.err.password': 'Password: at least 8 characters and not only digits.',
  'auth.err.mismatch': 'Passwords do not match.',
  'auth.err.registerFailed': 'Registration failed',
  'auth.err.noAccounts':
    'No accounts were registered from your current network. Recovery only works from the connection you signed up on.',
  'auth.err.lookupFailed': 'Lookup failed',
  'auth.err.resetFailed': 'Reset failed',
  'common.err.refreshFailed': 'Refresh failed',
  // update modal / banner
  'update.required.title': 'Update required',
  'update.required.body': 'Your launcher (v{current}) is no longer supported. Update to v{latest} to continue.',
  'update.starting': 'Starting…',
  'update.downloading': 'Downloading {pct}%',
  'update.now': 'Update now',
  'update.devBuild': '(Dev build — install the packaged app to actually update.)',
  'update.banner': 'Launcher update available: v{current} → v{latest}.',
  'update.updating': 'Updating…',
  'update.update': 'Update',
  'update.failed': 'Update failed',
  // header
  'hdr.home': 'Home',
  'hdr.coins': 'Coins',
  'hdr.profile': 'Profile',
  'hdr.refresh': 'Refresh servers & account',
  'hdr.settings': 'Settings',
  'hdr.logout': 'Log out',
  'hdr.minimize': 'Minimize',
  'hdr.maximize': 'Maximize',
  'hdr.close': 'Close',
  // settings
  'set.title': 'Settings',
  'set.sub': 'Configure the launcher and game defaults.',
  'common.back': 'Back',
  'set.sec.performance': 'Performance',
  'set.sec.game': 'Game',
  'set.sec.general': 'General',
  'set.ram.name': 'Allocated RAM',
  'set.ram.desc': '{ram} GB of {max} GB',
  'set.perf.name': 'Performance mode',
  'set.perf.desc': 'Reduce launcher animations and effects',
  'set.fs.name': 'Launch in fullscreen',
  'set.fs.desc': 'Start Minecraft maximized',
  'set.close.name': 'Close launcher on play',
  'set.close.desc': 'Free up memory while in game',
  'set.dir.name': 'Game directory',
  'set.browse': 'Browse',
  'set.auto.name': 'Automatic updates',
  'set.auto.desc': 'Keep mods and launcher up to date',
  'set.lang.name': 'Language',
  'set.lang.desc': 'Interface language',
  'set.loading': 'Loading settings…',
  'set.err.save': 'Could not save settings',
  'set.err.folder': 'Could not open the folder picker',
  // profile
  'prof.title': 'Profile',
  'prof.sub': 'Your account and Minecraft skin.',
  'prof.account': 'Account',
  'prof.online': 'Online',
  'prof.coins': 'Coins',
  'prof.uuid': 'Minecraft UUID',
  'prof.accountId': 'Account ID',
  'prof.skin': 'Your skin',
  'prof.rotate': 'Drag to rotate',
  'prof.uploading': 'Uploading…',
  'prof.addSkin': 'Add skin',
  'prof.skinFormat': 'PNG skin format · 64×64',
  'prof.dropHint': 'drag & drop or browse',
  'prof.browseFiles': 'Browse files',
  'prof.skin.tooBig': 'Skin file must be 256 KB or smaller.',
  'prof.skin.notPng': 'Skin must be a PNG image.',
  'prof.skin.badSize': 'Skin must be 64×64 (or 64×32) pixels — this is {w}×{h}.',
  'prof.skin.updated': 'Skin updated — applied in-game on your next join.',
  'prof.skin.failed': 'Skin upload failed.',
  // sidebar
  'side.servers': 'Servers',
  'side.online': '{n} online',
  'side.serverFallback': 'Minecraft server',
  'side.favRemove': 'Remove from favorites',
  'side.favAdd': 'Add to favorites',
  'side.empty': 'No servers available yet.',
  // hero CTA
  'cta.working': 'Working…',
  'cta.downloading': 'Downloading…',
  'cta.play': 'Play',
  'cta.download': 'Download',
  'blocked.soon': 'Coming soon',
  'blocked.dev': 'In development',
  // stat tiles
  'stat.version': 'Version',
  'stat.minecraft': 'Minecraft',
  'stat.type': 'Type',
  'stat.gameType': 'Game type',
  'stat.mode': 'Mode',
  'stat.pve': 'Player vs environment',
  'stat.pvp': 'Player vs player',
  // roleplay panel
  'rp.title': 'Your progress',
  'rp.loading': 'Loading…',
  'rp.empty': 'no data yet',
  // players
  'players.title': 'Players online',
  'players.noList': 'No player list advertised by this server.',
  'players.restarting': 'Server is restarting…',
  'players.offline': 'Server is offline.',
  // launch bar
  'lb.working': 'Working',
  'lb.verifying': 'Verifying',
  'lb.downloading': 'Downloading',
  'lb.workingDots': 'Working…',
  'lb.files': '{done}/{total} files',
  'lb.cancelTitle': 'Cancel download',
  'lb.cancel': 'Cancel',
  'lb.status.soon': "Coming soon — this server isn't open yet.",
  'lb.status.dev': 'In development — only whitelisted players can join.',
  'lb.status.running': 'Running — game launched.',
  'lb.status.restarting': 'Restarting… — the server is coming back up.',
  'lb.status.offline': 'Server looks offline — you can still try to launch.',
  'lb.status.ready': 'Ready to play · All files up to date',
  'lb.status.notDownloaded': 'Not downloaded yet',
  'lb.running': 'Running',
  'lb.moreActions': 'More actions',
  'lb.reinstall': 'Reinstall',
  'lb.reinstall.hint': 're-download every file',
  'lb.verifyFiles': 'Verify files',
  'lb.verify.hint': 'check & repair install',
  'lb.launch': 'LAUNCH',
  'lb.download': 'DOWNLOAD',
  // per-server status messages
  'status.gameExited': 'Game exited (code {code})',
  'status.canceled': 'Canceled.',
  'status.canceling': 'Canceling…',
  'status.downloadingFiles': 'Downloading client + files…',
  'status.downloaded': 'Downloaded. Ready to play.',
  'status.reinstalling': 'Reinstalling all files…',
  'status.reinstalled': 'Reinstalled. Ready to play.',
  'status.verifying': 'Verifying files…',
  'status.verified': 'Verified — {d} repaired, {del} removed, {u} ok.',
  'status.synced': 'Synced ({d} new, {del} removed). Launching…',
  'status.launched': 'Game launched.',
  'status.err.download': 'Download failed',
  'status.err.reinstall': 'Reinstall failed',
  'status.err.verify': 'Verify failed',
  'status.err.launch': 'Launch failed',
};

const ka: Record<string, string> = {
  'serverType.survival': 'გადარჩენა',
  'serverType.minigame': 'მინითამაში',
  'serverType.roleplay': 'როლური',
  'phase.scan': 'ფაილების სკანირება',
  'phase.download': 'ჩამოტვირთვა',
  'phase.cleanup': 'გასუფთავება',
  'phase.done': 'დასრულება',
  'hero.eyebrow.featured': 'რჩეული სერვერი',
  'hero.eyebrow.inDev': 'დამუშავების პროცესში',
  'hero.eyebrow.selected': 'არჩეული სერვერი',
  'group.fav': 'რჩეულები',
  'group.published': 'საჯარო',
  'group.featured': 'რჩეული',
  'group.inDev': 'დამუშავებაში',
  'auth.title.login': 'შესვლა',
  'auth.title.register': 'ანგარიშის შექმნა',
  'auth.title.recover': 'ანგარიშის აღდგენა',
  'auth.sub.login': 'შედი, რომ ჩამოტვირთო და ითამაშო შენს სერვერებზე.',
  'auth.sub.register': 'შექმენი ანგარიში, რომ ჩამოტვირთო და ითამაშო შენს სერვერებზე.',
  'auth.sub.recover.lookup': 'ელფოსტა არ სჭირდება — აღადგინე ანგარიში, რომელიც ამ ქსელიდან შექმენი.',
  'auth.sub.recover.pick': 'აირჩიე ანგარიში, რომლის აღდგენაც გსურს.',
  'auth.sub.recover.reset': 'დააყენე ახალი პაროლი "{name}"-ისთვის.',
  'auth.sub.recover.done': 'პაროლი განახლდა.',
  'auth.ph.username': 'მომხმარებელი',
  'auth.ph.password': 'პაროლი',
  'auth.ph.repeat': 'გაიმეორე პაროლი',
  'auth.ph.newPassword': 'ახალი პაროლი',
  'auth.btn.login': 'შესვლა',
  'auth.btn.register': 'ანგარიშის შექმნა',
  'auth.btn.forgot': 'დაგავიწყდა პაროლი?',
  'auth.btn.find': 'ჩემი ანგარიშების პოვნა',
  'auth.btn.setPassword': 'ახალი პაროლის დაყენება',
  'auth.btn.chooseOther': '← სხვა ანგარიშის არჩევა',
  'auth.btn.goLogin': 'შესვლაზე გადასვლა',
  'auth.btn.recover': 'აღდგენა →',
  'auth.btn.createOne': 'შექმენი',
  'auth.btn.backLogin': 'შესვლაზე დაბრუნება',
  'auth.switch.noAccount': 'არ გაქვს ანგარიში?',
  'auth.switch.haveAccount': 'უკვე გაქვს ანგარიში?',
  'auth.switch.remembered': 'გაიხსენე?',
  'auth.done.msg': '{name}-ის პაროლი განახლდა. შედი ახალი პაროლით.',
  'auth.err.loginFailed': 'შესვლა ვერ მოხერხდა',
  'auth.err.username': 'მომხმარებელი: 3–16 სიმბოლო, მხოლოდ ასოები/ციფრები/_.',
  'auth.err.password': 'პაროლი: მინიმუმ 8 სიმბოლო და არა მხოლოდ ციფრები.',
  'auth.err.mismatch': 'პაროლები არ ემთხვევა.',
  'auth.err.registerFailed': 'რეგისტრაცია ვერ მოხერხდა',
  'auth.err.noAccounts':
    'ამ ქსელიდან ანგარიში არ დარეგისტრირებულა. აღდგენა მუშაობს მხოლოდ იმ კავშირიდან, საიდანაც დარეგისტრირდი.',
  'auth.err.lookupFailed': 'ძებნა ვერ მოხერხდა',
  'auth.err.resetFailed': 'აღდგენა ვერ მოხერხდა',
  'common.err.refreshFailed': 'განახლება ვერ მოხერხდა',
  'update.required.title': 'საჭიროა განახლება',
  'update.required.body': 'შენი ლაუნჩერი (v{current}) აღარ არის მხარდაჭერილი. გასაგრძელებლად განაახლე v{latest}-მდე.',
  'update.starting': 'იწყება…',
  'update.downloading': 'ჩამოტვირთვა {pct}%',
  'update.now': 'განაახლე ახლა',
  'update.devBuild': '(Dev ბილდი — რეალური განახლებისთვის დააინსტალირე შეფუთული აპი.)',
  'update.banner': 'ხელმისაწვდომია ლაუნჩერის განახლება: v{current} → v{latest}.',
  'update.updating': 'განახლდება…',
  'update.update': 'განახლება',
  'update.failed': 'განახლება ვერ მოხერხდა',
  'hdr.home': 'მთავარი',
  'hdr.coins': 'მონეტები',
  'hdr.profile': 'პროფილი',
  'hdr.refresh': 'სერვერებისა და ანგარიშის განახლება',
  'hdr.settings': 'პარამეტრები',
  'hdr.logout': 'გასვლა',
  'hdr.minimize': 'ჩაკეცვა',
  'hdr.maximize': 'გაშლა',
  'hdr.close': 'დახურვა',
  'set.title': 'პარამეტრები',
  'set.sub': 'ლაუნჩერისა და თამაშის ნაგულისხმევი პარამეტრები.',
  'common.back': 'უკან',
  'set.sec.performance': 'წარმადობა',
  'set.sec.game': 'თამაში',
  'set.sec.general': 'ზოგადი',
  'set.ram.name': 'გამოყოფილი RAM',
  'set.ram.desc': '{ram} GB / {max} GB-დან',
  'set.perf.name': 'წარმადობის რეჟიმი',
  'set.perf.desc': 'შეამცირე ლაუნჩერის ანიმაციები და ეფექტები',
  'set.fs.name': 'სრულ ეკრანზე გაშვება',
  'set.fs.desc': 'Minecraft-ის გაშვება სრულ ეკრანზე',
  'set.close.name': 'თამაშისას ლაუნჩერის დახურვა',
  'set.close.desc': 'გაათავისუფლე მეხსიერება თამაშის დროს',
  'set.dir.name': 'თამაშის საქაღალდე',
  'set.browse': 'არჩევა',
  'set.auto.name': 'ავტომატური განახლებები',
  'set.auto.desc': 'განაახლე მოდები და ლაუნჩერი ავტომატურად',
  'set.lang.name': 'ენა',
  'set.lang.desc': 'ინტერფეისის ენა',
  'set.loading': 'პარამეტრები იტვირთება…',
  'set.err.save': 'პარამეტრების შენახვა ვერ მოხერხდა',
  'set.err.folder': 'საქაღალდის ამრჩევის გახსნა ვერ მოხერხდა',
  'prof.title': 'პროფილი',
  'prof.sub': 'შენი ანგარიში და Minecraft-ის სკინი.',
  'prof.account': 'ანგარიში',
  'prof.online': 'ონლაინ',
  'prof.coins': 'მონეტები',
  'prof.uuid': 'Minecraft UUID',
  'prof.accountId': 'ანგარიშის ID',
  'prof.skin': 'შენი სკინი',
  'prof.rotate': 'დაატრიალე გადათრევით',
  'prof.uploading': 'იტვირთება…',
  'prof.addSkin': 'სკინის დამატება',
  'prof.skinFormat': 'PNG სკინის ფორმატი · 64×64',
  'prof.dropHint': 'ჩააგდე ან აირჩიე',
  'prof.browseFiles': 'ფაილების არჩევა',
  'prof.skin.tooBig': 'სკინის ფაილი უნდა იყოს მაქსიმუმ 256 KB.',
  'prof.skin.notPng': 'სკინი უნდა იყოს PNG სურათი.',
  'prof.skin.badSize': 'სკინი უნდა იყოს 64×64 (ან 64×32) პიქსელი — ეს არის {w}×{h}.',
  'prof.skin.updated': 'სკინი განახლდა — გამოჩნდება თამაშში შემდეგ შესვლაზე.',
  'prof.skin.failed': 'სკინის ატვირთვა ვერ მოხერხდა.',
  'side.servers': 'სერვერები',
  'side.online': '{n} ონლაინ',
  'side.serverFallback': 'Minecraft სერვერი',
  'side.favRemove': 'რჩეულებიდან ამოშლა',
  'side.favAdd': 'რჩეულებში დამატება',
  'side.empty': 'სერვერები ჯერ არ არის.',
  'cta.working': 'მიმდინარეობს…',
  'cta.downloading': 'ჩამოტვირთვა…',
  'cta.play': 'თამაში',
  'cta.download': 'ჩამოტვირთვა',
  'blocked.soon': 'მალე',
  'blocked.dev': 'დამუშავებაში',
  'stat.version': 'ვერსია',
  'stat.minecraft': 'Minecraft',
  'stat.type': 'ტიპი',
  'stat.gameType': 'თამაშის ტიპი',
  'stat.mode': 'რეჟიმი',
  'stat.pve': 'მოთამაშე გარემოს წინააღმდეგ',
  'stat.pvp': 'მოთამაშე მოთამაშის წინააღმდეგ',
  'rp.title': 'შენი პროგრესი',
  'rp.loading': 'იტვირთება…',
  'rp.empty': 'ჯერ არ გითამაშია',
  'players.title': 'მოთამაშეები ონლაინ',
  'players.noList': 'სერვერი არ აჩვენებს მოთამაშეთა სიას.',
  'players.restarting': 'სერვერი გადაიტვირთება…',
  'players.offline': 'სერვერი ოფლაინია.',
  'lb.working': 'მუშაობს',
  'lb.verifying': 'შემოწმება',
  'lb.downloading': 'ჩამოტვირთვა',
  'lb.workingDots': 'მიმდინარეობს…',
  'lb.files': '{done}/{total} ფაილი',
  'lb.cancelTitle': 'ჩამოტვირთვის გაუქმება',
  'lb.cancel': 'გაუქმება',
  'lb.status.soon': 'მალე — ეს სერვერი ჯერ არ არის ღია.',
  'lb.status.dev': 'დამუშავებაში — მხოლოდ დაშვებულ მოთამაშეებს შეუძლიათ შესვლა.',
  'lb.status.running': 'გაშვებულია — თამაში დაიწყო.',
  'lb.status.restarting': 'გადაიტვირთება… — სერვერი ბრუნდება.',
  'lb.status.offline': 'სერვერი ოფლაინად ჩანს — მაინც შეგიძლია სცადო გაშვება.',
  'lb.status.ready': 'მზადაა სათამაშოდ · ყველა ფაილი განახლებულია',
  'lb.status.notDownloaded': 'ჯერ არ არის ჩამოტვირთული',
  'lb.running': 'გაშვებულია',
  'lb.moreActions': 'სხვა მოქმედებები',
  'lb.reinstall': 'თავიდან დაყენება',
  'lb.reinstall.hint': 'ყველა ფაილის თავიდან ჩამოტვირთვა',
  'lb.verifyFiles': 'ფაილების შემოწმება',
  'lb.verify.hint': 'შემოწმება და შეკეთება',
  'lb.launch': 'გაშვება',
  'lb.download': 'ჩამოტვირთვა',
  'status.gameExited': 'თამაში დაიხურა (კოდი {code})',
  'status.canceled': 'გაუქმდა.',
  'status.canceling': 'უქმდება…',
  'status.downloadingFiles': 'კლიენტისა და ფაილების ჩამოტვირთვა…',
  'status.downloaded': 'ჩამოიტვირთა. მზადაა სათამაშოდ.',
  'status.reinstalling': 'ყველა ფაილის თავიდან დაყენება…',
  'status.reinstalled': 'თავიდან დაყენდა. მზადაა სათამაშოდ.',
  'status.verifying': 'ფაილების შემოწმება…',
  'status.verified': 'შემოწმდა — {d} შეკეთდა, {del} წაიშალა, {u} რიგზეა.',
  'status.synced': 'სინქრონიზდა ({d} ახალი, {del} წაშლილი). გაშვება…',
  'status.launched': 'თამაში გაეშვა.',
  'status.err.download': 'ჩამოტვირთვა ვერ მოხერხდა',
  'status.err.reinstall': 'თავიდან დაყენება ვერ მოხერხდა',
  'status.err.verify': 'შემოწმება ვერ მოხერხდა',
  'status.err.launch': 'გაშვება ვერ მოხერხდა',
};

const DICTS: Record<Locale, Record<string, string>> = { en, ka };

function detectInitial(): Locale {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s === 'en' || s === 'ka') return s;
  } catch {
    /* ignore */
  }
  return 'ka'; // default: Georgian
}

export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

interface I18nCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFunc;
}

const Ctx = createContext<I18nCtx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLoc] = useState<Locale>(detectInitial);
  const setLocale = useCallback((l: Locale) => {
    setLoc(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  const t = useCallback<TFunc>(
    (key, vars) => {
      let s = DICTS[locale][key] ?? en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
      return s;
    },
    [locale],
  );
  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n must be used within I18nProvider');
  return c;
}

/** Compact KA/EN segmented toggle, usable anywhere (login form, header, settings). */
export function LangToggle({ className }: { className?: string }) {
  const { locale, setLocale } = useI18n();
  return (
    <div className={`lang-toggle${className ? ` ${className}` : ''}`} role="group" aria-label="Language">
      <button type="button" className={locale === 'ka' ? 'on' : ''} onClick={() => setLocale('ka')}>
        ქარ
      </button>
      <button type="button" className={locale === 'en' ? 'on' : ''} onClick={() => setLocale('en')}>
        EN
      </button>
    </div>
  );
}
