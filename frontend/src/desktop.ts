/**
 * What the desktop app can do beyond the page: the Tauri app's commands, or
 * Electron's preload API. In a plain browser tab none of this exists.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./api";

/** Running as a desktop app (Tauri or Electron), not a browser tab. */
export const isDesktop = isTauri || !!window.electronAPI;

/** The native folder dialog; null when cancelled or in a browser tab. */
export async function selectDirectory(): Promise<string | null> {
  if (isTauri) return invoke<string | null>("select_directory");
  return window.electronAPI ? window.electronAPI.selectDirectory() : null;
}

/** Ask before doing something; true to go ahead. */
export async function ask(message: string, ok?: string): Promise<boolean> {
  if (isTauri) return invoke<boolean>("ask_dialog", { message, ok }).catch(() => window.confirm(message));
  return window.confirm(message);
}

/** Report a failure. */
export async function tell(message: string): Promise<void> {
  if (isTauri) return invoke<void>("message_dialog", { message }).catch(() => window.alert(message));
  window.alert(message);
}

export function minimizeApp(): void {
  if (isTauri) void invoke("minimize_app").catch(() => {});
  else window.electronAPI?.minimize();
}

export function quitApp(): void {
  if (isTauri) void invoke("quit_app").catch(() => {});
  else window.electronAPI?.quit();
}
