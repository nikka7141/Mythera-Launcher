/// <reference types="vite/client" />

export {};

declare global {
  interface McUser {
    id: number;
    username: string;
    mcUuid: string;
    coins: number;
    skinUrl?: string | null;
  }

  interface McServer {
    id: number;
    slug: string;
    name: string;
    description: string;
    iconUrl: string | null;
    mcVersion: string;
    loader: string;
    // serverType -> the "TYPE" stat tile (survival/minigame/roleplay).
    serverType?: 'survival' | 'minigame' | 'roleplay';
    software?: string;
    // PvP flag from the server's server.properties (true → PvP, false → PvE) → the "MODE" displays.
    pvp?: boolean;
    host: string;
    port: number;
    // 'in_development' = whitelist-only join; 'featured' = coming-soon teaser (nobody joins).
    // isWhitelisted is true when the logged-in user may join an in_development server.
    statusMode?: 'published' | 'in_development' | 'featured';
    isWhitelisted?: boolean;
    // Pinned to the top of the launcher list by this user (sidecar-backed, per-user).
    isFavorite?: boolean;
  }

  interface McSyncProgress {
    serverId: number;
    phase: 'scan' | 'download' | 'cleanup' | 'done';
    file?: string;
    done: number;
    total: number;
  }

  interface McSyncResult {
    downloaded: number;
    deleted: number;
    unchanged: number;
  }

  interface McServerStatus {
    running: boolean;
    // Transient: the server was just (re)started and isn't answering yet → show "Restarting…".
    restarting?: boolean;
    online: number;
    max: number;
    // Sample of online players from the SLP response — present only when the server advertises one.
    // skinUrl = the player's real platform skin (resolved server-side by name); null → client renders by UUID.
    players?: { name: string; id: string; skinUrl?: string | null }[];
  }

  // Launcher-local preferences (persisted by the bridge: Tauri store in the app, localStorage in dev).
  interface McSettings {
    ramMb: number;
    maxRamMb: number;
    performanceMode: boolean;
    fullscreen: boolean;
    closeOnPlay: boolean;
    gameDir: string;
    autoUpdate: boolean;
  }

  interface McUpdateStatus {
    current: string;
    latest: string;
    minSupported: string;
    mustUpdate: boolean;
    updateAvailable: boolean;
    packaged: boolean;
  }

  interface McLaunchLog {
    serverId: number;
    line: string;
  }

  interface McLaunchExit {
    serverId: number;
    code: number | null;
  }

  interface McBridge {
    platform: NodeJS.Platform;
    login(creds: { username: string; password: string }): Promise<McUser>;
    register(creds: { username: string; password: string }): Promise<McUser>;
    /** Accounts that registered from this device's current IP — the IP-recovery candidate list. */
    recoverLookup(): Promise<{ accounts: { username: string }[] }>;
    /** Reset a chosen account's password — allowed only if it registered from this IP. */
    recoverReset(args: { username: string; newPassword: string }): Promise<{ ok: boolean }>;
    logout(): Promise<boolean>;
    session(): Promise<McUser | null>;
    refreshUser(): Promise<McUser>;
    /** Upload a 64×64 (or 64×32) PNG skin (raw bytes). Returns the new public skin URL. */
    uploadSkin(bytes: number[]): Promise<{ skinUrl: string }>;
    servers(): Promise<McServer[]>;
    setFavorite(serverId: number, favorite: boolean): Promise<{ favorite: boolean }>;
    serverStatus(serverId: number): Promise<McServerStatus>;
    installed(serverId: number): Promise<boolean>;
    install(serverId: number): Promise<{ installed: boolean }>;
    sync(serverId: number): Promise<McSyncResult>;
    cancelSync(serverId: number): Promise<void>;
    launch(serverId: number): Promise<{ pid: number | null }>;
    updateStatus(): Promise<McUpdateStatus>;
    updateNow(): Promise<{ started: boolean }>;
    getSettings(): Promise<McSettings>;
    saveSettings(settings: McSettings): Promise<McSettings>;
    browseGameDir(): Promise<string | null>;
    onUpdateProgress(cb: (p: { percent: number }) => void): () => void;
    onUpdateError(cb: (p: { message: string }) => void): () => void;
    onSyncProgress(cb: (p: McSyncProgress) => void): () => void;
    onLaunchLog(cb: (p: McLaunchLog) => void): () => void;
    onLaunchExit(cb: (p: McLaunchExit) => void): () => void;
  }

  interface Window {
    mc: McBridge;
  }
}
