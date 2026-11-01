/**
 * Floating windows: the app is one transparent window over the desktop, so it
 * has to tell the app shell (Tauri or Electron) where its windows are. Clicks
 * anywhere else go through to whatever is underneath.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { isTauri } from "../api";
import type { Rect } from "./layout";

/**
 * Tauri: the app reports where its windows are, and whether a drag or resize
 * is under way (the pointer can leave every window mid-drag, and must keep
 * coming here until the button comes up). Linux cuts the window to these
 * regions; macOS and Windows watch the pointer against them.
 */
const tauriOverlay = { regions: [] as Rect[], interacting: false };

function reportTauri(): void {
  void invoke("overlay_regions", tauriOverlay).catch(() => {});
}

function useTauriInteraction(): void {
  useEffect(() => {
    if (!isTauri) return;
    const set = (interacting: boolean) => {
      if (tauriOverlay.interacting === interacting) return;
      tauriOverlay.interacting = interacting;
      reportTauri();
    };
    const down = () => set(true);
    const up = () => set(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", up);
    };
  }, []);
}

/**
 * macOS and Windows: ignore the mouse except while it is over a window.
 * Ignored mouse moves are still forwarded, which is how we notice the
 * pointer coming back.
 */
export function useHoverClickThrough(): void {
  useTauriInteraction();
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.setIgnoreMouse || api.platform === "linux") return;
    let ignoring: boolean | null = null;
    const set = (ignore: boolean) => {
      if (ignore === ignoring) return;
      ignoring = ignore;
      api.setIgnoreMouse(ignore);
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
      api.setIgnoreMouse(false);
    };
  }, []);
}

function measured(): Rect[] {
  return Array.from(document.querySelectorAll(".wm-window"), (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), w: Math.ceil(r.width) + 1, h: Math.ceil(r.height) + 1 };
  });
}

let settleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Linux: shape the window to its windows. While they move, the shape also
 * covers where they're headed, so nothing is clipped mid-animation; once the
 * animation settles it shrinks back to just the windows. Never the whole
 * window: without a compositor, that would paint the screen black.
 */
export function updateShape(targets: Rect[]): void {
  if (isTauri) {
    tauriOverlay.regions = [...measured(), ...targets];
    reportTauri();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      tauriOverlay.regions = measured();
      reportTauri();
    }, 350);
    return;
  }
  const api = window.electronAPI;
  if (api?.platform !== "linux" || !api.setShape) return;
  const send = (rects: Rect[]) =>
    api.setShape(rects.map((r) => ({ x: r.x, y: r.y, width: r.w, height: r.h })));
  send([...measured(), ...targets]);
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => send(measured()), 350);
}
