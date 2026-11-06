/**
 * Floating windows: the app is one transparent window over the desktop, so it
 * has to tell the shell (Tauri or Electron) where its windows are. Clicks
 * anywhere else go through to whatever is underneath.
 */
import { useEffect } from "react";
import { desktop, type ShellRect } from "../desktop";
import type { Rect } from "./layout";

function measured(): Rect[] {
  return Array.from(document.querySelectorAll(".wm-window"), (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), w: Math.ceil(r.width) + 1, h: Math.ceil(r.height) + 1 };
  });
}

const toShell = (rects: Rect[]): ShellRect[] => rects.map((r) => ({ x: r.x, y: r.y, width: r.w, height: r.h }));

/**
 * macOS and Windows: ignore the mouse except while it is over a window.
 * Electron still forwards ignored mouse moves, which is how we notice the
 * pointer coming back; Tauri watches the pointer against the rects we send.
 */
export function useHoverClickThrough(): void {
  useEffect(() => {
    const api = desktop;
    if (!api || api.clickThrough !== "hover") return;
    let ignoring: boolean | null = null;
    const set = (ignore: boolean) => {
      if (ignore === ignoring) return;
      ignoring = ignore;
      api.setIgnoreMouse(ignore, ignore ? toShell(measured()) : []);
    };
    const onMove = (e: MouseEvent) => {
      // Mid-drag or mid-resize the pointer can leave every window; keep
      // taking events until the button comes up.
      if (e.buttons) return;
      const el = e.target instanceof Element ? e.target : null;
      set(!el?.closest(".wm-window"));
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      api.setIgnoreMouse(false, []);
    };
  }, []);
}

let settleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Follow the windows as they move. While they animate, the clickable area
 * also covers where they're headed, so nothing is clipped mid-animation; once
 * the animation settles it shrinks back to just the windows.
 *
 * Linux shapes the window to them. Never the whole window: under Electron
 * without a compositor, that would paint the screen black. Under Tauri on
 * macOS/Windows this keeps the pointer watch's rects current.
 */
export function updateShape(targets: Rect[]): void {
  const api = desktop;
  if (!api) return;
  const send =
    api.clickThrough === "shape" ? api.setShape : api.setHitRects ? api.setHitRects : null;
  if (!send) return;
  send(toShell([...measured(), ...targets]));
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => send(toShell(measured())), 350);
}
