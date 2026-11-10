/**
 * What the UI knows about the HTTP backend (a browser tab against
 * `python backend/main.py`). The Tauri app has no separate backend.
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
