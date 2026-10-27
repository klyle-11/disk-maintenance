/**
 * The desktop shell the UI is running in: Tauri, Electron (legacy), or none
 * (a plain browser tab against the dev server).
 *
 * Components use `desktop` instead of `window.electronAPI` so they work the
 * same in both shells. Backend supervision only exists under Electron; in
 * Tauri the backend is part of the app, so those methods are absent.
 */

import { invoke } from "@tauri-apps/api/core";
import type { BackendStatus } from "./electron.d";

/** True inside the Tauri app. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface DesktopAPI {
  /** Node-style platform name: "darwin", "win32" or "linux". */
  getPlatform: () => Promise<string>;
  /** Native folder picker. Resolves to null if cancelled. */
  selectDirectory: () => Promise<string | null>;
  /** Show a path in Finder/Explorer. Never opens or runs it. */
  revealPath: (targetPath: string) => Promise<boolean>;

  // Electron only: the Python backend runs as a separate, supervised process.
  getBackendStatus?: () => Promise<BackendStatus | null>;
  onBackendStatus?: (callback: (status: BackendStatus) => void) => () => void;
  retryBackend?: () => Promise<BackendStatus | null>;
  openBackendLog?: () => Promise<boolean>;
}

const tauriDesktop: DesktopAPI = {
  getPlatform: async () =>
    (await invoke<{ platform: string }>("app_info")).platform,
  selectDirectory: () => invoke<string | null>("select_directory"),
  revealPath: (path) => invoke<boolean>("reveal_path", { path }),
};

function electronDesktop(): DesktopAPI | undefined {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api) return undefined;
  return {
    getPlatform: async () => api.platform,
    selectDirectory: api.selectDirectory,
    revealPath: api.revealPath,
    getBackendStatus: api.getBackendStatus,
    onBackendStatus: api.onBackendStatus,
    retryBackend: api.retryBackend,
    openBackendLog: api.openBackendLog,
  };
}

export const desktop: DesktopAPI | undefined = isTauri
  ? tauriDesktop
  : electronDesktop();

/**
 * Tell the user something. A native message box in Tauri (not every
 * platform's webview shows `window.alert`), `alert` elsewhere.
 */
export async function notify(message: string): Promise<void> {
  if (isTauri) {
    await invoke("message_dialog", { message }).catch(() => {});
  } else {
    window.alert(message);
  }
}

/** Ask an OK/Cancel question. Resolves to true for OK. */
export async function ask(message: string): Promise<boolean> {
  if (isTauri) {
    return invoke<boolean>("confirm_dialog", { message }).catch(() => false);
  }
  return window.confirm(message);
}
