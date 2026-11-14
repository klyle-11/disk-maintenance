/**
 * The desktop the window cluster sits on.
 *
 * Draws each unit at its packed position, centred in the viewport, and turns
 * pointer gestures into reducer actions: dragging a title bar onto another
 * window swaps the two (windows never come loose: a drop anywhere else snaps
 * back), dragging an edge resizes, with the opposite edge held still, and
 * dragging the main window moves the whole cluster.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { desktop } from "../desktop";
import { useHoverClickThrough, updateShape } from "./clickThrough";
import { bounds, fits, type Point, type Rect } from "./layout";
import { CLUSTER_PAD as PAD, KINDS, minHeight, type Unit, type WmAction, type WmState } from "./state";

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const DRAG_THRESHOLD = 4;

export interface UnitView {
  unit: Unit;
  /** Where to draw the unit, in canvas pixels. */
  rect: Rect;
  active: boolean;
  dragging: boolean;
  dropTarget: boolean;
  resizing: boolean;
  /** Changes each time the window should flash. */
  flashKey: number | null;
  /** How far the unit is being dragged from its slot. */
  dragOffset: Point | null;
}

export interface UnitControls {
  beginDrag: (e: ReactPointerEvent) => void;
  beginResize: (e: ReactPointerEvent, member: number, handle: Handle) => void;
  activate: () => void;
  shade: () => void;
  close: () => void;
  move: (delta: -1 | 1) => void;
  /** Drag every window at once (the main window's title bar). */
  beginPan: (e: ReactPointerEvent) => void;
  /** Put the cluster back in the middle of the screen. */
  resetPan: () => void;
}

type Interaction =
  | { kind: "drag"; id: string; dx: number; dy: number; target: string | null }
  | { kind: "resize"; id: string; handle: Handle }
  | { kind: "pan" }
  | null;

interface ClusterProps {
  state: WmState;
  dispatch: Dispatch<WmAction>;
  renderUnit: (view: UnitView, controls: UnitControls) => ReactNode;
}

function hitTest(state: WmState, x: number, y: number, skip: string): string | null {
  for (const unit of state.units) {
    const r = state.rects[unit.id];
    if (unit.id !== skip && r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return unit.id;
  }
  return null;
}

/** Largest value between `from` and `to` that `ok` accepts (ok(from) holds). */
function furthest(from: number, to: number, ok: (v: number) => boolean): number {
  if (ok(to)) return to;
  let good = from;
  let bad = to;
  while (Math.abs(bad - good) > 1) {
    const mid = Math.round((good + bad) / 2);
    if (ok(mid)) good = mid;
    else bad = mid;
  }
  return good;
}

/** The pan that puts a window's grab point under the pointer, kept on screen. */
function panUnder(pointer: Point, grab: Point, rect: Rect, centred: Point, clamp: (p: Point) => Point): Point {
  return clamp({ x: pointer.x - grab.x - (centred.x + rect.x), y: pointer.y - grab.y - (centred.y + rect.y) });
}

/** Follow the pointer until it is released, then clean up. */
function track(onMove: (e: PointerEvent) => void, onEnd: (cancelled: boolean) => void) {
  const move = (e: PointerEvent) => onMove(e);
  const up = () => finish(false);
  const cancel = () => finish(true);
  function finish(cancelled: boolean) {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    onEnd(cancelled);
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}

/** A drag of the main window that just moved the app onto another display. */
interface Hop {
  id: string;
  /** Where the pointer was in the moved window (CSS px). */
  at: Point;
  /** Where in the dragged window it was grabbed. */
  grab: Point;
  time: number;
}

export function Cluster({ state, dispatch, renderUnit }: ClusterProps) {
  const desktopRef = useRef<HTMLDivElement>(null);
  const hop = useRef<Hop | null>(null);
  const lastPointer = useRef<{ x: number; y: number; time: number } | null>(null);
  const [hopCount, setHopCount] = useState(0);
  const [interaction, setInteraction] = useState<Interaction>(null);
  // While a gesture is under way the cluster stays put instead of
  // re-centring under the pointer.
  const [frozen, setFrozen] = useState<Point | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = desktopRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      dispatch({ type: "view", size: { w: Math.round(width), h: Math.round(height) } });
    });
    observer.observe(el);
    // Animate moves only after the first layout has been drawn in place.
    const frame = requestAnimationFrame(() => setReady(true));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [dispatch]);

  const box = bounds(Object.values(state.rects));
  const canvas = {
    w: Math.max(state.view.w, box.w + PAD * 2),
    h: Math.max(state.view.h, box.h + PAD * 2),
  };
  const centred = {
    x: Math.round(canvas.w / 2 - (box.x + box.w / 2)),
    y: Math.round(canvas.h / 2 - (box.y + box.h / 2)),
  };
  // Dragging the main window moves the cluster off centre, but never off screen.
  const clampPan = (p: Point): Point => {
    const axis = (v: number, lo: number, hi: number) => (lo > hi ? 0 : Math.min(hi, Math.max(lo, Math.round(v))));
    return {
      x: axis(p.x, PAD - box.x - centred.x, canvas.w - PAD - (box.x + box.w) - centred.x),
      y: axis(p.y, PAD - box.y - centred.y, canvas.h - PAD - (box.y + box.h) - centred.y),
    };
  };
  const pan = clampPan(state.pan);
  const offset = frozen ?? { x: centred.x + pan.x, y: centred.y + pan.y };

  // After moving to another display, put the dragged window back under the
  // pointer, and again once the new display's size arrives.
  useEffect(() => {
    const h = hop.current;
    if (!h) return;
    if (Date.now() - h.time > 1500) {
      hop.current = null;
      return;
    }
    const r = state.rects[h.id];
    if (!r) return;
    const seen = lastPointer.current;
    const pointer = seen && seen.time > h.time ? seen : h.at;
    dispatch({ type: "pan", pan: panUnder(pointer, h.grab, r, centred, clampPan) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- placed on a hop and when the view resizes
  }, [hopCount, state.view.w, state.view.h]);

  useHoverClickThrough();

  // Linux shapes the window to its windows; keep the shape following them,
  // including where they are headed while they animate.
  const shapeKey = `${JSON.stringify(state.rects)}|${offset.x},${offset.y}|${JSON.stringify(interaction)}|${state.units.length}`;
  useEffect(() => {
    const desk = desktopRef.current;
    if (!desk) return;
    const frame = requestAnimationFrame(() => {
      const origin = desk.getBoundingClientRect();
      const targets = Object.values(state.rects).map((r) => ({
        x: Math.floor(origin.left + r.x + offset.x - desk.scrollLeft),
        y: Math.floor(origin.top + r.y + offset.y - desk.scrollTop),
        w: r.w + 1,
        h: r.h + 1,
      }));
      updateShape(targets);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shapeKey covers what moves
  }, [shapeKey]);

  const beginDrag = (id: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startOffset = offset;
    const canvasEl = (e.currentTarget as HTMLElement).closest(".wm-canvas");
    let live = false;
    let target: string | null = null;
    track(
      (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!live) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          live = true;
          setFrozen(startOffset);
        }
        const origin = canvasEl?.getBoundingClientRect();
        if (origin) {
          target = hitTest(state, ev.clientX - origin.left - startOffset.x, ev.clientY - origin.top - startOffset.y, id);
        }
        setInteraction({ kind: "drag", id, dx, dy, target });
      },
      (cancelled) => {
        if (live && target && !cancelled) dispatch({ type: "swap", a: id, b: target });
        setInteraction(null);
        setFrozen(null);
      },
    );
  };

  // The latest layout, for a drag that outlives the render it began in.
  const geometry = useRef({ clampPan, centred, rects: state.rects });
  const live = useRef(state);
  useLayoutEffect(() => {
    geometry.current = { clampPan, centred, rects: state.rects };
    live.current = state;
  });

  const beginResize = (id: string, e: ReactPointerEvent, member: number, handle: Handle) => {
    if (e.button !== 0) return;
    const index = state.units.findIndex((u) => u.id === id);
    const unit = state.units[index];
    const start = state.rects[id];
    if (!unit || !start || unit.shaded) return;
    e.preventDefault();
    e.stopPropagation();

    // Units docked before this one don't move while it resizes, so they are
    // the walls it can't grow through.
    const earlier = state.units.slice(0, index).map((u) => state.rects[u.id]).filter(Boolean);
    const min = KINDS[unit.kind].min;
    const startMember = unit.sizes[member];
    const sx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
    const sy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
    const startX = e.clientX;
    const startY = e.clientY;

    // The rect for a member size, holding the edges opposite the handle. If
    // that pulls the window off its neighbour, holding the other edge instead
    // keeps it docked.
    const candidates = (w: number, h: number): Rect[] => {
      const W = start.w + (w - startMember.w);
      const H = h;
      const xs = sx < 0 ? [start.x + start.w - W, start.x] : [start.x, start.x + start.w - W];
      const ys = sy < 0 ? [start.y + start.h - H, start.y] : [start.y, start.y + start.h - H];
      return xs.flatMap((x) => ys.map((y) => ({ x, y, w: W, h: H })));
    };
    const spot = (w: number, h: number) => candidates(w, h).find((c) => fits(c, earlier));

    setFrozen(offset);
    setInteraction({ kind: "resize", id, handle });
    track(
      (ev) => {
        let w = Math.max(min.w, Math.round(startMember.w + sx * (ev.clientX - startX)));
        // What the content needs can change mid-drag (a narrower window wraps more).
        const floor = minHeight(live.current, unit);
        let h = Math.max(floor, Math.round(startMember.h + sy * (ev.clientY - startY)));
        let rect = spot(w, h);
        if (!rect) {
          // Ran into a neighbour: grow as far as it allows on each axis.
          w = furthest(startMember.w, w, (v) => !!spot(v, startMember.h));
          h = furthest(Math.max(floor, startMember.h), h, (v) => !!spot(w, v));
          rect = spot(w, h);
          if (!rect) return;
        }
        const sizes = unit.sizes.map((s, i) => ({ w: i === member ? w : s.w, h }));
        dispatch({ type: "resize", id, sizes, candidates: [rect] });
      },
      () => {
        setInteraction(null);
        setFrozen(null);
      },
    );
  };

  const beginPan = (id: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const win = (e.currentTarget as HTMLElement).closest(".wm-window")?.getBoundingClientRect();
    const grab = win ? { x: e.clientX - win.left, y: e.clientY - win.top } : { x: 0, y: 0 };
    let asking = false;
    setInteraction({ kind: "pan" });
    track(
      (ev) => {
        lastPointer.current = { x: ev.clientX, y: ev.clientY, time: Date.now() };
        const off = ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;
        // Off this window: maybe onto another display; the app follows.
        if (off && desktop?.followCursorToMonitor) {
          if (!asking) {
            asking = true;
            void desktop
              .followCursorToMonitor()
              .then((at) => {
                if (!at) return;
                hop.current = { id, at, grab, time: Date.now() };
                setHopCount((n) => n + 1);
              })
              .finally(() => {
                asking = false;
              });
          }
          return;
        }
        // Keep the grabbed point under the pointer (as far as the screen allows).
        const g = geometry.current;
        const r = g.rects[id];
        if (r) dispatch({ type: "pan", pan: panUnder({ x: ev.clientX, y: ev.clientY }, grab, r, g.centred, g.clampPan) });
      },
      () => setInteraction(null),
    );
  };

  const drag = interaction?.kind === "drag" ? interaction : null;
  const resize = interaction?.kind === "resize" ? interaction : null;
  // A stable DOM order keeps scroll positions when units are reordered.
  const units = [...state.units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return (
    <div
      ref={desktopRef}
      onScroll={() => updateShape([])}
      className={[
        "wm-desktop",
        ready ? "is-ready" : "",
        interaction ? "is-interacting" : "",
        resize ? `is-resizing-${resize.handle}` : "",
        drag ? "is-dragging" : "",
        interaction?.kind === "pan" ? "is-panning" : "",
      ].join(" ")}
    >
      <div className="wm-canvas" style={{ width: canvas.w, height: canvas.h }}>
        {/* eslint-disable-next-line react-hooks/refs -- the controls touch refs only in pointer handlers, never while rendering */}
        {units.map((unit) => {
          const r = state.rects[unit.id];
          if (!r) return null;
          const view: UnitView = {
            unit,
            rect: { x: r.x + offset.x, y: r.y + offset.y, w: r.w, h: r.h },
            active: state.activeId === unit.id,
            dragging: drag?.id === unit.id,
            dropTarget: drag?.target === unit.id,
            resizing: resize?.id === unit.id,
            flashKey: state.flash?.id === unit.id ? state.flash.n : null,
            dragOffset: drag?.id === unit.id ? { x: drag.dx, y: drag.dy } : null,
          };
          const controls: UnitControls = {
            beginDrag: (e) => beginDrag(unit.id, e),
            beginResize: (e, member, handle) => beginResize(unit.id, e, member, handle),
            activate: () => dispatch({ type: "activate", id: unit.id }),
            shade: () => dispatch({ type: "shade", id: unit.id }),
            close: () => dispatch({ type: "close", id: unit.id }),
            move: (delta) => dispatch({ type: "move", id: unit.id, delta }),
            beginPan: (e) => beginPan(unit.id, e),
            resetPan: () => dispatch({ type: "pan", pan: { x: 0, y: 0 } }),
          };
          return <Fragment key={unit.id}>{renderUnit(view, controls)}</Fragment>;
        })}
      </div>
    </div>
  );
}
