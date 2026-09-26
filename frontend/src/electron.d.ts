/**
 * Type declarations for the Electron API exposed via the preload script.
 */

export interface BackendStatus {
  /** idle | starting | ready | restarting | error */
  state: "idle" | "starting" | "ready" | "restarting" | "error";
  /** Human-readable explanation, shown to the user when something is wrong. */
  detail: string;
  port: number;
  /** Base URL the renderer should talk to, e.g. http://127.0.0.1:8001 */
  baseUrl: string;
  logPath: string;
  restarts: number;
  recentLines: string[];
}

export interface ElectronAPI {
  platform: NodeJS.Platform;

  /**
   * Opens a native directory selection dialog.
   * @returns Promise that resolves to the selected directory path, or null if cancelled.
   */
  selectDirectory: () => Promise<string | null>;

  /** Current backend status, including the base URL to talk to. */
  getBackendStatus: () => Promise<BackendStatus | null>;

  /** Subscribe to backend status changes. Returns an unsubscribe function. */
  onBackendStatus: (callback: (status: BackendStatus) => void) => () => void;

  /** Restart the backend after a failure. */
  retryBackend: () => Promise<BackendStatus | null>;

  /** Reveal the backend log in the file manager. */
  openBackendLog: () => Promise<boolean>;

  /** Reveal a scanned path in Finder/Explorer. */
  revealPath: (targetPath: string) => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
