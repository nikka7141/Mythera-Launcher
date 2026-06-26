// Custom title-bar controls for the frameless window (tauri.conf.json decorations:false). Each call is a
// no-op in a plain browser (design/dev work at :5173) where there is no Tauri window to drive.
import { getCurrentWindow } from '@tauri-apps/api/window';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const win = () => (isTauri ? getCurrentWindow() : null);

export const minimizeWindow = () => void win()?.minimize();
export const toggleMaximizeWindow = () => void win()?.toggleMaximize();
export const closeWindow = () => void win()?.close();
