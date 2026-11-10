/**
 * The desktop shell the UI is running in: Tauri, or none (a plain browser tab
 * against the dev server).
 */

import { invoke } from "@tauri-apps/api/core";

/** True inside the Tauri app. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ShellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopAPI {
  /** Node-style platform name: "darwin", "win32" or "linux". */
  platform: string;
  /** Native folder picker. Resolves to null if cancelled. */
  selectDirectory: () => Promise<string | null>;
  /** Show a path in Finder/Explorer. Never opens or runs it. */
  revealPath: (targetPath: string) => Promise<boolean>;
  minimize: () => void;
  quit: () => void;
  /** The main window's close button: hides to the tray where there is one, else quits. */
  close: () => void;
  /** Whether `close` hides to the tray (macOS, Windows) rather than quitting. */
  closesToTray: () => Promise<boolean>;

  /**
   * The app floats on the desktop, so clicks must pass through it except over
   * its windows. "hover": the UI turns click-through on when the pointer
   * leaves its windows (macOS, Windows). "shape": only the given rects take
   * clicks (Linux).
   */
  clickThrough: "hover" | "shape";
  /** hover: let clicks through (or stop); `rects` are the UI's windows. */
  setIgnoreMouse: (ignore: boolean, rects: ShellRect[]) => void;
  /** hover: the UI's windows moved (Tauri watches the pointer against them). */
  setHitRects?: (rects: ShellRect[]) => void;
  /**
   * Mid-drag of the main window with the pointer off this window: move the
   * app to the display the pointer is on. Resolves to the pointer's place in
   * the moved window (CSS px), or null if it stayed put.
   */
  followCursorToMonitor?: () => Promise<{ x: number; y: number } | null>;
  /** shape: only these window-relative rects take clicks; [] means all of it. */
  setShape: (rects: ShellRect[]) => void;
}

/** The webview's OS, read from its user agent (no round trip needed). */
function tauriPlatform(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return "win32";
  if (/Mac/i.test(ua)) return "darwin";
  return "linux";
}

const ignoreError = () => {};

function makeTauriDesktop(): DesktopAPI {
  const platform = tauriPlatform();
  return {
    platform,
    selectDirectory: () => invoke<string | null>("select_directory"),
    revealPath: (path) => invoke<boolean>("reveal_path", { path }),
    minimize: () => void invoke("minimize_window").catch(ignoreError),
    quit: () => void invoke("quit_app").catch(ignoreError),
    close: () => void invoke("close_main_window").catch(ignoreError),
    closesToTray: () => invoke<boolean>("keeps_running_in_tray").catch(() => false),
    clickThrough: platform === "linux" ? "shape" : "hover",
    setIgnoreMouse: (ignore, rects) => void invoke("set_click_through", { ignore, rects }).catch(ignoreError),
    setHitRects: (rects) => void invoke("set_hit_rects", { rects }).catch(ignoreError),
    setShape: (rects) => void invoke("set_input_region", { rects }).catch(ignoreError),
    followCursorToMonitor: () => invoke<{ x: number; y: number } | null>("follow_cursor_to_monitor").catch(() => null),
  };
}

export const desktop: DesktopAPI | undefined = isTauri ? makeTauriDesktop() : undefined;

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

/**
 * Put text on the clipboard. Falls back to a hidden text field where a
 * webview refuses the async clipboard API.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the old way.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
