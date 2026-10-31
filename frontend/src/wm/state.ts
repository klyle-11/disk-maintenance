/**
 * Window manager state: which windows are open, in what order, at what size.
 *
 * Every change runs through `wmReducer`, which re-packs the cluster in the
 * same step, so positions never lag behind the windows they belong to. The
 * state lives in `wmStore` so any window (or a finishing scan) can open and
 * close others.
 */
import { createStore } from "../store";
import { bounds, fits, packCluster, type Point, type Rect, type Size } from "./layout";

export type Kind =
  | "status"
  | "controls"
  | "skins"
  | "library"
  | "backend"
  | "dhm"
  | "dhm-out"
  | "di"
  | "di-cmds"
  | "tip"
  | "scan"
  | "findings"
  | "types"
  | "compare"
  | "cmp-pair";

interface KindSpec {
  /** Default size of each member window. */
  size: Size;
  min: Size;
  /** 2 for a pair of windows that dock and move as one (comparison trees). */
  members: 1 | 2;
  /** Reopened, at the same size and place, on the next launch. */
  persist: boolean;
  /** Has a close button. */
  closable: boolean;
}

export const KINDS: Record<Kind, KindSpec> = {
  status: { size: { w: 330, h: 112 }, min: { w: 290, h: 104 }, members: 1, persist: true, closable: false },
  controls: { size: { w: 330, h: 92 }, min: { w: 290, h: 84 }, members: 1, persist: true, closable: false },
  skins: { size: { w: 330, h: 124 }, min: { w: 250, h: 96 }, members: 1, persist: true, closable: true },
  library: { size: { w: 290, h: 300 }, min: { w: 220, h: 140 }, members: 1, persist: true, closable: true },
  backend: { size: { w: 380, h: 200 }, min: { w: 300, h: 150 }, members: 1, persist: false, closable: true },
  dhm: { size: { w: 300, h: 214 }, min: { w: 260, h: 180 }, members: 1, persist: true, closable: true },
  "dhm-out": { size: { w: 640, h: 330 }, min: { w: 380, h: 160 }, members: 1, persist: true, closable: true },
  di: { size: { w: 640, h: 330 }, min: { w: 360, h: 160 }, members: 1, persist: true, closable: true },
  "di-cmds": { size: { w: 270, h: 330 }, min: { w: 210, h: 140 }, members: 1, persist: true, closable: true },
  tip: { size: { w: 290, h: 176 }, min: { w: 220, h: 120 }, members: 1, persist: true, closable: true },
  scan: { size: { w: 310, h: 178 }, min: { w: 270, h: 160 }, members: 1, persist: false, closable: true },
  findings: { size: { w: 580, h: 330 }, min: { w: 360, h: 160 }, members: 1, persist: false, closable: true },
  types: { size: { w: 320, h: 330 }, min: { w: 240, h: 150 }, members: 1, persist: false, closable: true },
  compare: { size: { w: 330, h: 206 }, min: { w: 290, h: 190 }, members: 1, persist: false, closable: true },
  "cmp-pair": { size: { w: 420, h: 380 }, min: { w: 260, h: 180 }, members: 2, persist: false, closable: true },
};

/** Height of a title bar, which is all a shaded window shows. */
export const TITLE_H = 18;

/** Breathing room around the cluster inside the desktop. */
export const CLUSTER_PAD = 24;

/** Sizes, as a share of the default, a new window tries so it fits on screen. */
const OPEN_SCALES = [1, 0.85, 0.7, 0.55];

export interface Unit {
  id: string;
  kind: Kind;
  /** One size per member window; members of a pair share a height. */
  sizes: Size[];
  shaded: boolean;
  /** What the window shows: a scan or comparison session id, a tip id. */
  ref?: string;
  /** The window this one belongs to. It opens beside it and closes with it. */
  parent?: string;
}

export interface WmState {
  /** In docking order: earlier units sit nearer the middle. */
  units: Unit[];
  /** Where each unit is, in cluster coordinates. */
  rects: Record<string, Rect>;
  view: Size;
  activeId: string | null;
  /** Bumped to replay the "here I am" flash on a window. */
  flash: { id: string; n: number } | null;
}

export type WmAction =
  | { type: "open"; unit: Unit }
  | { type: "close"; id: string }
  | { type: "focus"; id: string }
  | { type: "activate"; id: string }
  | { type: "shade"; id: string }
  | { type: "resize"; id: string; sizes: Size[]; candidates: Rect[] }
  | { type: "swap"; a: string; b: string }
  | { type: "move"; id: string; delta: -1 | 1 }
  | { type: "arrange" }
  | { type: "view"; size: Size };

export function outerSize(unit: Unit): Size {
  const w = unit.sizes.reduce((sum, s) => sum + s.w, 0);
  return { w, h: unit.shaded ? TITLE_H : unit.sizes[0].h };
}

export function newUnit(kind: Kind, id: string, extra?: Partial<Unit>): Unit {
  const spec = KINDS[kind];
  return {
    id,
    kind,
    sizes: Array.from({ length: spec.members }, () => ({ ...spec.size })),
    shaded: false,
    ...extra,
  };
}

function relayout(units: Unit[], rects: Record<string, Rect>, view: Size): Record<string, Rect> {
  return packCluster(
    units.map((u) => {
      const prev = rects[u.id];
      const hint: Point | undefined = prev ? { x: prev.x, y: prev.y } : undefined;
      return { id: u.id, ...outerSize(u), hint };
    }),
    view,
  );
}

/**
 * Give a unit a new shape. Takes the first candidate spot that still docks
 * onto the units before it; when none does the change is refused, which is
 * what makes a window stop growing when it runs into a neighbour.
 */
function reshape(state: WmState, id: string, change: (u: Unit) => Unit, candidates: Rect[]): WmState {
  const index = state.units.findIndex((u) => u.id === id);
  if (index < 0) return state;
  const earlier = state.units.slice(0, index).map((u) => state.rects[u.id]).filter(Boolean);
  const spot = candidates.find((c) => fits(c, earlier));
  if (!spot) return state;
  const units = state.units.map((u) => (u.id === id ? change(u) : u));
  const rects = relayout(units, { ...state.rects, [id]: spot }, state.view);
  return { ...state, units, rects };
}

/**
 * Open a unit at the largest size that keeps the cluster on screen (when
 * nothing fits, it opens small and the desktop scrolls). A unit with a parent
 * is placed as close to it as it will go.
 */
function placeNew(state: WmState, unit: Unit): { units: Unit[]; rects: Record<string, Rect> } {
  const min = KINDS[unit.kind].min;
  const room = { w: state.view.w - CLUSTER_PAD * 2, h: state.view.h - CLUSTER_PAD * 2 };
  const parent = unit.parent ? state.rects[unit.parent] : undefined;
  let fallback: { units: Unit[]; rects: Record<string, Rect> } | null = null;
  for (const scale of OPEN_SCALES) {
    const sized = {
      ...unit,
      sizes: unit.sizes.map((s) => ({
        w: Math.max(min.w, Math.round(s.w * scale)),
        h: Math.max(min.h, Math.round(s.h * scale)),
      })),
    };
    const { w, h } = outerSize(sized);
    const hints = parent
      ? {
          ...state.rects,
          [unit.id]: { x: Math.round(parent.x + parent.w / 2 - w / 2), y: Math.round(parent.y + parent.h / 2 - h / 2), w, h },
        }
      : state.rects;
    const units = [...state.units, sized];
    const rects = relayout(units, hints, state.view);
    const box = bounds(Object.values(rects));
    if (box.w <= room.w && box.h <= room.h) return { units, rects };
    fallback = { units, rects };
  }
  return fallback!;
}

function swapRects(rects: Record<string, Rect>, a: Rect, b: Rect, idA: string, idB: string) {
  // Each takes the other's centre; the packer nudges it to the nearest fit.
  return {
    ...rects,
    [idA]: { ...a, x: Math.round(b.x + b.w / 2 - a.w / 2), y: Math.round(b.y + b.h / 2 - a.h / 2) },
    [idB]: { ...b, x: Math.round(a.x + a.w / 2 - b.w / 2), y: Math.round(a.y + a.h / 2 - b.h / 2) },
  };
}

function swap(state: WmState, a: string, b: string): WmState {
  const i = state.units.findIndex((u) => u.id === a);
  const j = state.units.findIndex((u) => u.id === b);
  if (i < 0 || j < 0 || i === j) return state;
  const units = [...state.units];
  [units[i], units[j]] = [units[j], units[i]];
  const ra = state.rects[a];
  const rb = state.rects[b];
  const hints = ra && rb ? swapRects(state.rects, ra, rb, a, b) : state.rects;
  return { ...state, units, rects: relayout(units, hints, state.view), activeId: a };
}

/** A unit and everything that belongs to it, however deep. */
function withChildren(units: Unit[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (u.parent && ids.has(u.parent) && !ids.has(u.id)) {
        ids.add(u.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function wmReducer(state: WmState, action: WmAction): WmState {
  switch (action.type) {
    case "open": {
      const existing = state.units.find((u) => u.id === action.unit.id);
      if (existing) return wmReducer(state, { type: "focus", id: existing.id });
      const { units, rects } = placeNew(state, action.unit);
      return {
        ...state,
        units,
        rects,
        activeId: action.unit.id,
        flash: { id: action.unit.id, n: (state.flash?.n ?? 0) + 1 },
      };
    }
    case "close": {
      if (!state.units.some((u) => u.id === action.id)) return state;
      const gone = withChildren(state.units, action.id);
      const units = state.units.filter((u) => !gone.has(u.id));
      const rects = { ...state.rects };
      for (const id of gone) delete rects[id];
      return {
        ...state,
        units,
        rects: relayout(units, rects, state.view),
        activeId: state.activeId && gone.has(state.activeId) ? null : state.activeId,
      };
    }
    case "focus": {
      const unit = state.units.find((u) => u.id === action.id);
      if (!unit) return state;
      const next = { ...state, activeId: action.id, flash: { id: action.id, n: (state.flash?.n ?? 0) + 1 } };
      return unit.shaded ? wmReducer(next, { type: "shade", id: action.id }) : next;
    }
    case "activate":
      return state.activeId === action.id ? state : { ...state, activeId: action.id };
    case "shade": {
      const unit = state.units.find((u) => u.id === action.id);
      const rect = state.rects[action.id];
      if (!unit || !rect) return state;
      const toggled = { ...unit, shaded: !unit.shaded };
      const { h } = outerSize(toggled);
      // Keep whichever edge is docked: the top, or the bottom.
      const candidates = [
        { ...rect, h },
        { ...rect, y: rect.y + rect.h - h, h },
      ];
      const next = reshape(state, action.id, () => toggled, candidates);
      if (next !== state) return next;
      // Neither edge docks any more; let the packer find it a spot.
      const units = state.units.map((u) => (u.id === action.id ? toggled : u));
      return { ...state, units, rects: relayout(units, state.rects, state.view) };
    }
    case "resize":
      return reshape(state, action.id, (u) => ({ ...u, sizes: action.sizes }), action.candidates);
    case "swap":
      return swap(state, action.a, action.b);
    case "move": {
      const i = state.units.findIndex((u) => u.id === action.id);
      const other = state.units[i + action.delta];
      return i < 0 || !other ? state : swap(state, action.id, other.id);
    }
    case "arrange":
      return { ...state, rects: relayout(state.units, {}, state.view) };
    case "view":
      return action.size.w === state.view.w && action.size.h === state.view.h
        ? state
        : { ...state, view: action.size };
  }
}

// ---------------------------------------------------------------------------
// Persistence: the persistent windows' order, sizes and places.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "wm-layout-v2";

interface Saved {
  units: Unit[];
  rects: Record<string, Rect>;
}

function clampSizes(unit: Unit): Unit {
  const spec = KINDS[unit.kind];
  const h = Math.max(spec.min.h, Math.round(unit.sizes?.[0]?.h || spec.size.h));
  const sizes = Array.from({ length: spec.members }, (_, i) => ({
    w: Math.max(spec.min.w, Math.round(unit.sizes?.[i]?.w || spec.size.w)),
    h,
  }));
  return { id: unit.id, kind: unit.kind, sizes, shaded: !!unit.shaded, ref: unit.ref, parent: unit.parent };
}

function initialState(defaults: Unit[], view: Size): WmState {
  let units = defaults;
  let rects: Record<string, Rect> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Saved;
      const restored = (saved.units || []).filter((u) => u && KINDS[u.kind]?.persist).map(clampSizes);
      // The windows that can't be closed are always there.
      for (const fixed of defaults.filter((d) => !KINDS[d.kind].closable).reverse()) {
        if (!restored.some((u) => u.id === fixed.id)) restored.unshift(fixed);
      }
      const ids = new Set(restored.map((u) => u.id));
      units = restored.map((u) => (u.parent && !ids.has(u.parent) ? { ...u, parent: undefined } : u));
      rects = saved.rects || {};
    }
  } catch {
    // Unreadable or no storage: start from the default arrangement.
  }
  return { units, rects: relayout(units, rects, view), view, activeId: null, flash: null };
}

function saveState(state: WmState): void {
  const units = state.units.filter((u) => KINDS[u.kind].persist);
  const rects: Record<string, Rect> = {};
  for (const u of units) if (state.rects[u.id]) rects[u.id] = state.rects[u.id];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ units, rects } satisfies Saved));
  } catch {
    // Storage unavailable: the layout just won't be remembered.
  }
}

// ---------------------------------------------------------------------------
// The live window manager.
// ---------------------------------------------------------------------------

/** First launch: status and controls in the middle, the two CLIs and the library around them. */
const DEFAULT_UNITS: Unit[] = [
  newUnit("status", "status"),
  newUnit("controls", "controls"),
  newUnit("dhm", "dhm"),
  newUnit("dhm-out", "dhm-out", { parent: "dhm" }),
  newUnit("di", "di"),
  newUnit("di-cmds", "di-cmds", { parent: "di" }),
  newUnit("library", "library"),
];

export const wmStore = createStore<WmState>(
  initialState(DEFAULT_UNITS, { w: window.innerWidth, h: window.innerHeight }),
);

export function wmDispatch(action: WmAction): void {
  wmStore.set((state) => wmReducer(state, action));
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
wmStore.subscribe(() => {
  // Remember the arrangement a moment after it stops changing.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState(wmStore.get()), 400);
});

/** Open a window, or flash it if it's already open. */
export function openWindow(kind: Kind, id: string = kind, extra?: Partial<Unit>): void {
  wmDispatch({ type: "open", unit: newUnit(kind, id, extra) });
}

export function closeWindow(id: string): void {
  wmDispatch({ type: "close", id });
}

export function isOpen(id: string): boolean {
  return wmStore.get().units.some((u) => u.id === id);
}
