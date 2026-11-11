/**
 * du-hast-much: per-folder sizes with live progress, and browsing: click a
 * folder in the table to open it, BACK to return. Every folder's results are
 * kept (across restarts too) and shown at once when revisited, while a fresh
 * run brings them up to date.
 */
import {
  formatBytes,
  getDuHastMuchHistory,
  saveDuHastMuchToHistory,
  streamDuHastMuch,
  type DuHastMuchResponse,
  type DuHastMuchResult,
} from "../api";
import { createStore, useStore } from "../store";
import { openWindow } from "../wm/state";
import { isReady } from "./app";

/** One scan as kept in history and in the folder cache. */
export interface DhmRecord extends DuHastMuchResponse {
  path: string;
  depth: number;
  top?: number;
  latest: boolean;
  timestamp: number;
}

export interface DhmState {
  path: string;
  top: number | null;
  latest: boolean;
  running: boolean;
  /** Showing remembered results while a fresh run updates them. */
  refreshing: boolean;
  error: string | null;
  results: DuHastMuchResult[];
  meta: { totalSize: number; totalFiles: number; elapsedSeconds: number } | null;
  /** The folder the shown results are for, and how they are shown. */
  shown: { path: string; latest: boolean; top: number | null } | null;
  /** When the shown results were measured (ms), for "as of". */
  shownAt: number | null;
  /** Folders opened before this one, for BACK. */
  trail: string[];
  history: DhmRecord[];
}

// ---------------------------------------------------------------------------
// Every folder's last results, so revisiting one shows it at once.
// ---------------------------------------------------------------------------

const CACHE_KEY = "dhm-folders-v1";
const CACHE_MAX = 80;

function readCache(): Record<string, DhmRecord> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const cache: Record<string, DhmRecord> = readCache();

function remember(record: DhmRecord): void {
  cache[record.path] = record;
  const keys = Object.keys(cache).sort((a, b) => cache[b].timestamp - cache[a].timestamp);
  for (const key of keys.slice(CACHE_MAX)) delete cache[key];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or unavailable: folders are just measured again.
  }
}

function initial(): DhmState {
  const history = getDuHastMuchHistory() as DhmRecord[];
  const last = history[0];
  for (const record of history) if (!cache[record.path] || cache[record.path].timestamp < record.timestamp) cache[record.path] = record;
  return {
    path: last?.path ?? "",
    top: last ? last.top ?? null : 10,
    latest: last?.latest ?? false,
    running: false,
    refreshing: false,
    error: null,
    results: last?.results ?? [],
    meta: last
      ? { totalSize: last.total_size, totalFiles: last.total_files, elapsedSeconds: last.elapsed_seconds }
      : null,
    shown: last ? { path: last.path, latest: last.latest, top: last.top ?? null } : null,
    shownAt: last?.timestamp ?? null,
    trail: [],
    history,
  };
}

export const dhmStore = createStore<DhmState>(initial());

export function useDhm<S>(select: (s: DhmState) => S): S {
  return useStore(dhmStore, select);
}

export function patchDhm(patch: Partial<DhmState>): void {
  dhmStore.set((s) => ({ ...s, ...patch }));
}

let abort: AbortController | null = null;
/** Bumped by every run, so a superseded run's late results are ignored. */
let runToken = 0;

/**
 * Measure `root`'s folders. With remembered results on screen the table
 * stays put and is replaced when the run finishes; otherwise rows appear as
 * each folder is measured. `record` adds the run to the recent-scans list.
 */
async function measure(root: string, record: boolean): Promise<void> {
  abort?.abort();
  const token = ++runToken;
  const controller = new AbortController();
  abort = controller;
  const { top, latest } = dhmStore.get();
  const cached = cache[root];
  patchDhm({
    path: root,
    running: true,
    refreshing: !!cached,
    error: null,
    shown: { path: root, latest, top },
    ...(cached
      ? {
          results: cached.results,
          meta: { totalSize: cached.total_size, totalFiles: cached.total_files, elapsedSeconds: cached.elapsed_seconds },
          shownAt: cached.timestamp,
        }
      : { results: [], meta: null, shownAt: null }),
  });
  const results: DuHastMuchResult[] = [];
  try {
    const summary = await streamDuHastMuch(
      { path: root, top: top || undefined, latest },
      (result) => {
        results.push(result);
        if (token === runToken && !cached) patchDhm({ results: [...results] });
      },
      controller.signal,
    );
    if (token !== runToken) return;
    const fresh: DhmRecord = {
      results,
      total_size: summary.totalSize,
      total_files: summary.totalFiles,
      elapsed_seconds: summary.elapsedSeconds,
      path: root,
      depth: 1,
      top: top || undefined,
      latest,
      timestamp: Date.now(),
    };
    remember(fresh);
    if (record) saveDuHastMuchToHistory(fresh);
    patchDhm({
      results,
      meta: summary,
      shownAt: fresh.timestamp,
      running: false,
      refreshing: false,
      history: record ? (getDuHastMuchHistory() as DhmRecord[]) : dhmStore.get().history,
    });
  } catch (err) {
    if (token !== runToken) return;
    const stopped = controller.signal.aborted;
    patchDhm({ running: false, refreshing: false, error: stopped ? null : err instanceof Error ? err.message : "Scan failed" });
  } finally {
    if (abort === controller) abort = null;
  }
}

/** Scan the typed folder (SCAN / Enter). A new folder is a step BACK can undo. */
export async function runDhm(): Promise<void> {
  const { path, shown } = dhmStore.get();
  const root = path.trim();
  if (!root) return;
  if (shown && shown.path !== root) patchDhm({ trail: [...dhmStore.get().trail, shown.path].slice(-50) });
  await measure(root, true);
}

/** Open a folder from the table (or the recent list), remembering where we were. */
export function openDhmFolder(path: string): void {
  const { shown, trail } = dhmStore.get();
  if (shown?.path === path) {
    void measure(path, false);
    return;
  }
  patchDhm({ trail: shown ? [...trail, shown.path].slice(-50) : trail });
  void measure(path, false);
}

/** Open the du-hast-much window on a folder (from a scan or a comparison). */
export function showInDhm(path: string): void {
  openWindow("dhm");
  if (isReady()) openDhmFolder(path);
  else patchDhm({ path });
}

/** The folder above `path` ("C:\\Users" for "C:\\Users\\me"), or null at a root. */
export function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return null;
  const parent = trimmed.slice(0, cut);
  if (!parent) return "/";
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** Where BACK goes: the folder opened before this one, or else the parent. */
export function backTarget(state: Pick<DhmState, "trail" | "shown">): string | null {
  if (state.trail.length) return state.trail[state.trail.length - 1];
  return state.shown ? parentOf(state.shown.path) : null;
}

export function dhmBack(): void {
  const state = dhmStore.get();
  const target = backTarget(state);
  if (!target) return;
  patchDhm({ trail: state.trail.length ? state.trail.slice(0, -1) : [] });
  void measure(target, false);
}

export function stopDhm(): void {
  abort?.abort();
}

// ---------------------------------------------------------------------------
// Output: the CLI table, as ANSI lines drawn in the skin's colours.
// ---------------------------------------------------------------------------

const ESC = "\x1b[";
const BORDER = `${ESC}90m`;
const RESET = `${ESC}0m`;

interface Column {
  title: string;
  width: number;
  right?: boolean;
}

interface Cell {
  text: string;
  color?: string;
}

export function timeAgo(mtime: number): string {
  if (!mtime) return "n/a";
  const delta = Date.now() / 1000 - mtime;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  const days = Math.floor(delta / 86400);
  return days < 365 ? `${days}d ago` : `${Math.floor(days / 365)}y ago`;
}

function fit(text: string, width: number): string {
  return text.length > width ? "…" + text.slice(text.length - width + 1) : text;
}

function rule(columns: Column[], left: string, mid: string, right: string): string {
  return BORDER + left + columns.map((c) => "─".repeat(c.width + 2)).join(mid) + right + RESET;
}

function row(columns: Column[], cells: Cell[]): string {
  const body = columns
    .map((c, i) => {
      const text = fit(cells[i]?.text ?? "", c.width);
      const padded = c.right ? text.padStart(c.width) : text.padEnd(c.width);
      const colored = cells[i]?.color ? cells[i].color + padded + RESET : padded;
      return ` ${colored} ${BORDER}│${RESET}`;
    })
    .join("");
  return `${BORDER}│${RESET}${body}`;
}

function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** A line of the table; result rows carry the folder they open. */
export interface DhmLine {
  text: string;
  path?: string;
}

/** The du-hast-much table for the current results. Empty before any scan. */
export function dhmLines(
  state: Pick<DhmState, "results" | "meta" | "running" | "shown" | "refreshing" | "shownAt">,
): DhmLine[] {
  const { results, meta, running, shown, refreshing, shownAt } = state;
  if (!shown || (results.length === 0 && !running)) return [];
  const latest = shown.latest;
  const lines: (string | DhmLine)[] = [
    // The path is cut from the left to keep the line inside the table's width.
    refreshing
      ? `${ESC}1;36mdu-hast-much${RESET} — ${ESC}36m${fit(shown.path, 40)}${RESET} ${ESC}2mas of ${shownAt ? timeAgo(shownAt / 1000) : "earlier"} · updating…${RESET}`
      : `${ESC}1;36mdu-hast-much${RESET} — ${running ? "scanning" : "scanned"} ${ESC}36m${fit(shown.path, 54)}${RESET}`,
    "",
  ];
  if (results.length === 0) return lines.map((l) => (typeof l === "string" ? { text: l } : l));

  // Results stream in as each folder finishes; the order is ours to impose.
  const sorted = [...results].sort(latest ? (a, b) => b.latest_mtime - a.latest_mtime : (a, b) => b.size - a.size);
  const rows = shown.top ? sorted.slice(0, shown.top) : sorted;
  const total = meta?.totalSize ?? results.reduce((sum, r) => sum + r.size, 0);
  const largest = rows.reduce((max, r) => Math.max(max, r.size), 0) || 1;

  const columns: Column[] = latest
    ? [
        { title: "#", width: 3, right: true },
        { title: "Directory", width: 15 },
        { title: "Size", width: 9, right: true },
        { title: "Files", width: 7, right: true },
        { title: "Avg size", width: 9, right: true },
        { title: "Latest", width: 9 },
      ]
    : [
        { title: "#", width: 3, right: true },
        { title: "Directory", width: 24 },
        { title: "Size", width: 9, right: true },
        { title: "% Total", width: 7, right: true },
        { title: "Usage", width: 12 },
      ];

  lines.push(
    `${ESC}1m${latest ? "Recently modified directories" : "Disk usage by directory"}${RESET}${ESC}2m  · → send to SCAN · ⟳ update snapshot${RESET}`,
  );
  lines.push(rule(columns, "┌", "┬", "┐"));
  lines.push(row(columns, columns.map((c) => ({ text: c.title, color: `${ESC}2m` }))));
  lines.push(rule(columns, "├", "┼", "┤"));
  rows.forEach((r, i) => {
    const big = r.size > 1 << 30 ? `${ESC}1;33m` : undefined;
    if (latest) {
      // Lots of small new files is the pattern worth noticing.
      const swarm = r.avg_file_size < 100 * 1024 && r.files > 50 ? `${ESC}1;31m` : undefined;
      lines.push({
        path: r.path,
        text: row(columns, [
          { text: String(i + 1) },
          { text: r.name, color: swarm },
          { text: formatBytes(r.size), color: big },
          { text: r.files.toLocaleString() },
          { text: formatBytes(r.avg_file_size) },
          { text: timeAgo(r.latest_mtime) },
        ]),
      });
    } else {
      const share = total > 0 ? (r.size / total) * 100 : 0;
      lines.push({
        path: r.path,
        text: row(columns, [
          { text: String(i + 1) },
          { text: r.name },
          { text: formatBytes(r.size), color: big },
          { text: `${share.toFixed(1)}%`, color: share > 20 ? `${ESC}1;33m` : undefined },
          { text: bar(r.size / largest, 12), color: `${ESC}36m` },
        ]),
      });
    }
  });
  lines.push(rule(columns, "├", "┼", "┤"));
  lines.push(
    row(columns, columns.map((_, i) =>
      i === 1 ? { text: "TOTAL", color: `${ESC}1m` } : i === 2 ? { text: formatBytes(total), color: `${ESC}1m` } : !latest && i === 3 ? { text: "100%" } : { text: "" },
    )),
  );
  lines.push(rule(columns, "└", "┴", "┘"));
  lines.push("");
  if (meta) {
    lines.push(
      `${ESC}2mTotal: ${formatBytes(total)} across ${meta.totalFiles.toLocaleString()} files · scanned in ${meta.elapsedSeconds.toFixed(1)}s${RESET}`,
    );
  } else {
    const files = results.reduce((sum, r) => sum + r.files, 0);
    lines.push(`${ESC}2mScanning… ${results.length} directories · ${formatBytes(total)} · ${files.toLocaleString()} files${RESET}`);
  }
  return lines.map((l) => (typeof l === "string" ? { text: l } : l));
}
