/**
 * The main window's side of the tray panel: a button there brings the main
 * window up (Rust does that) and asks for a tool, which opens here, or comes
 * forward if it's already open. Tauri only.
 */
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../desktop";
import { openWindow } from "../wm/state";
import { clearCaches } from "./caches";
import { newCompare } from "./compare";
import { openOffload } from "./offload";
import { newScan } from "./scan";

export type TrayTool = "scan" | "compare" | "offload" | "dhm" | "di" | "tips" | "caches";

export function openFromTray(tool: TrayTool | null): void {
  switch (tool) {
    case "scan":
      return newScan();
    case "compare":
      return newCompare();
    case "offload":
      return openOffload();
    case "dhm":
    case "di":
    case "tips":
      return openWindow(tool);
    case "caches":
      // The clear reports into the di terminal, as from its own button.
      openWindow("di");
      void clearCaches();
      return;
  }
}

/** Follow the tray panel's buttons. Returns the unsubscribe. */
export function followTray(): () => void {
  if (!isTauri) return () => {};
  const off = listen<TrayTool | null>("tray://open", (e) => openFromTray(e.payload));
  return () => void off.then((f) => f());
}
