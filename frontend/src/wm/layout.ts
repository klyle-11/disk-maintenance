/**
 * Cluster layout: every window docks edge-to-edge onto the ones before it,
 * packed around a centre point.
 *
 * Units (a window, or a pair of windows that move together) are placed in
 * order. The first sits at the origin; each later one must share at least
 * MIN_CONTACT px of edge with a unit placed before it and overlap nothing, so
 * the cluster is always one connected piece. A unit keeps its previous spot
 * (its hint) whenever that is still valid, which is what stops the layout
 * reshuffling every time something opens, closes or resizes. Otherwise it
 * takes the free docking spot that keeps the cluster closest to the
 * viewport's shape, nearest its hint or the cluster's centre.
 */

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point, Size {}

export interface LayoutItem extends Size {
  id: string;
  /** Where this unit's top-left was last time, in cluster coordinates. */
  hint?: Point;
}

/** Shared edge, in px, that counts as two windows being stuck together. */
export const MIN_CONTACT = 48;

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Length of the edge two rects share; 0 when they don't touch. */
export function contactLength(a: Rect, b: Rect): number {
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if ((a.x + a.w === b.x || b.x + b.w === a.x) && yOverlap > 0) return yOverlap;
  if ((a.y + a.h === b.y || b.y + b.h === a.y) && xOverlap > 0) return xOverlap;
  return 0;
}

function contactNeeded(a: Rect, b: Rect, vertical: boolean): number {
  return vertical ? Math.min(MIN_CONTACT, a.h, b.h) : Math.min(MIN_CONTACT, a.w, b.w);
}

/** Touches `b` along enough of an edge to count as docked. */
export function docked(a: Rect, b: Rect): boolean {
  const length = contactLength(a, b);
  if (length <= 0) return false;
  const vertical = a.x + a.w === b.x || b.x + b.w === a.x;
  return length >= contactNeeded(a, b, vertical);
}

/** Free of every placed rect and docked onto at least one of them. */
export function fits(rect: Rect, placed: Rect[]): boolean {
  if (placed.length === 0) return true;
  let touching = false;
  for (const p of placed) {
    if (overlaps(rect, p)) return false;
    if (!touching && docked(rect, p)) touching = true;
  }
  return touching;
}

export function bounds(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Every spot where a w×h rect docks onto `p`, aligned to something nearby. */
function dockingSpots(p: Rect, size: Size, placed: Rect[], extra: Point[]): Rect[] {
  const { w, h } = size;
  const ys = [p.y, p.y + p.h - h, p.y + Math.round((p.h - h) / 2)];
  const xs = [p.x, p.x + p.w - w, p.x + Math.round((p.w - w) / 2)];
  for (const q of placed) {
    ys.push(q.y, q.y + q.h - h, q.y + q.h, q.y - h);
    xs.push(q.x, q.x + q.w - w, q.x + q.w, q.x - w);
  }
  for (const e of extra) {
    ys.push(e.y);
    xs.push(e.x);
  }

  const spots: Rect[] = [];
  for (const y of ys) {
    for (const x of [p.x + p.w, p.x - w]) {
      const r = { x, y, w, h };
      if (contactLength(r, p) >= contactNeeded(r, p, true)) spots.push(r);
    }
  }
  for (const x of xs) {
    for (const y of [p.y + p.h, p.y - h]) {
      const r = { x, y, w, h };
      if (contactLength(r, p) >= contactNeeded(r, p, false)) spots.push(r);
    }
  }
  return spots;
}

function bestSpot(item: LayoutItem, placed: Rect[], view: Size): Rect {
  const box = bounds(placed);
  const target = item.hint
    ? { x: item.hint.x + item.w / 2, y: item.hint.y + item.h / 2 }
    : { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const extra = item.hint ? [item.hint] : [];
  const vw = Math.max(view.w, 1);
  const vh = Math.max(view.h, 1);

  let best: Rect | null = null;
  let bestScore = Infinity;
  for (const p of placed) {
    for (const spot of dockingSpots(p, item, placed, extra)) {
      if (placed.some((q) => overlaps(spot, q))) continue;
      const grown = bounds([box, spot]);
      // How much of the viewport the cluster would fill; past 1 it scrolls.
      const fill = Math.max(grown.w / vw, grown.h / vh);
      const overflow = Math.max(0, fill - 1);
      const dx = (spot.x + spot.w / 2 - target.x) / vw;
      const dy = (spot.y + spot.h / 2 - target.y) / vh;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const score = item.hint
        ? distance * 2 + fill * 0.5 + overflow * 5
        : fill + distance * 0.3 + overflow * 5;
      if (score < bestScore - 1e-9) {
        best = spot;
        bestScore = score;
      }
    }
  }
  // Unreachable: the spot right of the right-most unit is always free.
  return best ?? { x: box.x + box.w, y: box.y, w: item.w, h: item.h };
}

/**
 * Place every unit, in order. Returns each unit's rect in cluster
 * coordinates (centre the cluster's bounds in the viewport to draw it).
 */
export function packCluster(items: LayoutItem[], view: Size): Record<string, Rect> {
  const placed: Rect[] = [];
  const out: Record<string, Rect> = {};
  for (const item of items) {
    const w = Math.max(1, Math.round(item.w));
    const h = Math.max(1, Math.round(item.h));
    const sized = { ...item, w, h };
    let rect: Rect;
    if (item.hint && fits({ ...item.hint, w, h }, placed)) {
      rect = { x: Math.round(item.hint.x), y: Math.round(item.hint.y), w, h };
    } else if (placed.length === 0) {
      rect = { x: -Math.round(w / 2), y: -Math.round(h / 2), w, h };
    } else {
      rect = bestSpot(sized, placed, view);
    }
    placed.push(rect);
    out[item.id] = rect;
  }
  return out;
}
