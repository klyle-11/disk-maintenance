/**
 * Floating windows: the app is one transparent window over the desktop, so it
 * has to tell the shell (Tauri) where its windows are. Clicks
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
 * macOS and Windows: the shell takes the mouse only while the pointer is over
 * one of the rects we send. A drag or resize can carry the pointer off every
 * window, so tell it while a press that began on a window is still down.
 */
export function useHoverClickThrough(): void {
  useEffect(() => {
    const api = desktop;
    const hold = api?.clickThrough === "hover" ? api.setPointerHold : undefined;
    if (!hold) return;
    let held = false;
    const set = (next: boolean) => {
      if (next === held) return;
      held = next;
      hold(next);
    };
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".wm-window")) set(true);
    };
    const release = () => set(false);
    // A release the page never heard of must not leave the app holding the mouse.
    const onMove = (e: MouseEvent) => {
      if (!e.buttons) set(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", release);
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", release);
      window.removeEventListener("mousemove", onMove);
      set(false);
    };
  }, []);
}

let settleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Follow the windows as they move. While they animate, the clickable area
 * also covers where they're headed, so nothing is clipped mid-animation; once
 * the animation settles it shrinks back to just the windows.
 *
 * Linux shapes the window to them. On macOS/Windows these are the rects the pointer watch takes the mouse over.
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
