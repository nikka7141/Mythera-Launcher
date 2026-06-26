import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Directory of this config — cwd-independent so .env loading works no matter where the
// build is invoked from.
const cfgDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode, command }) => {
  // Resolve the backend API URL. Precedence: shell env (CI) > this app's .env files (.env.production for
  // release builds) > empty. Under Tauri the renderer talks only to the Rust backend, which bakes the same
  // URL via build.rs (reads .env.production); this guard fails the build early if that value is bad.
  const env = loadEnv(mode, cfgDir, '');
  const apiUrl = process.env.VITE_API_URL || env.VITE_API_URL || '';

  // Fail-fast guard: never bake a localhost/empty API URL into a packaged build — players could not reach
  // the backend. Only fires on `vite build` (not dev/preview). Escape hatch ALLOW_LOCALHOST_BUILD=1 for an
  // intentional local test build.
  const isLocalhost = !apiUrl || /localhost|127\.0\.0\.1/.test(apiUrl);
  if (command === 'build' && isLocalhost && !process.env.ALLOW_LOCALHOST_BUILD) {
    throw new Error(
      `[launcher build] VITE_API_URL is "${apiUrl || '(empty)'}". Refusing to bake a localhost/empty ` +
        `API URL into a packaged build — players could not reach the backend. Set VITE_API_URL to the ` +
        `public backend (e.g. https://api.yourdomain/api/v1) in .env.production or the ` +
        `shell, or set ALLOW_LOCALHOST_BUILD=1 for an intentional local test build.`,
    );
  }

  // Browser DEV (design work at :5173, no Tauri): the dev shim in mc-bridge.dev.ts hits the REAL backend
  // over same-origin /api so the backend's CORS allow-list isn't involved.
  // Target must be 127.0.0.1 — on Windows "localhost" resolves to ::1 first and the proxy gets ECONNREFUSED.
  const apiTarget = process.env.MC_DEV_API_TARGET || 'http://127.0.0.1:3001';

  return {
    plugins: [react()],
    // Tauri expects a fixed dev port and unobtrusive output.
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    },
  };
});
