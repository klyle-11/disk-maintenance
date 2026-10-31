/**
 * du-hast-much: per-folder sizes with live progress. The settings window and
 * the output window both read this state.
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

/** One scan as kept in history. */
export interface DhmRecord extends DuHastMuchResponse {
  path: string;
  depth: number;
  top?: number;
  latest: boolean;
  timestamp: number;
}

export interface DhmState {
  path: string;
  depth: number;
  top: number | null;
  latest: boolean;
  running: boolean;
  error: string | null;
  results: DuHastMuchResult[];
  meta: { totalSize: number; totalFiles: number; elapsedSeconds: number } | null;
  /** The path and mode the shown results are for. */
  shown: { path: string; latest: boolean; top: number | null } | null;
  history: DhmRecord[];
}

function initial(): DhmState {
  const history = getDuHastMuchHistory() as DhmRecord[];
  const last = history[0];
  return {
    path: last?.path ?? "",
    depth: last?.depth ?? 1,
    top: last ? last.top ?? null : 10,
    latest: last?.latest ?? false,
    running: false,
    error: null,
    results: last?.results ?? [],
    meta: last
      ? { totalSize: last.total_size, totalFiles: last.total_files, elapsedSeconds: last.elapsed_seconds }
      : null,
    shown: last ? { path: last.path, latest: last.latest, top: last.top ?? null } : null,
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

export async function runDhm(): Promise<void> {
  const { path, depth, top, latest, running } = dhmStore.get();
  const root = path.trim();
  if (!root || running) return;
  const controller = new AbortController();
  abort = controller;
  const results: DuHastMuchResult[] = [];
  patchDhm({ running: true, error: null, results: [], meta: null, shown: { path: root, latest, top } });
  try {
    const summary = await streamDuHastMuch(
      { path: root, depth, top: top || undefined, latest },
      (result) => {
        results.push(result);
        patchDhm({ results: [...results] });
      },
      controller.signal,
    );
    const record: DhmRecord = {
      results,
      total_size: summary.totalSize,
      total_files: summary.totalFiles,
      elapsed_seconds: summary.elapsedSeconds,
      path: root,
      depth,
      top: top || undefined,
      latest,
      timestamp: Date.now(),
    };
    saveDuHastMuchToHistory(record);
    patchDhm({ meta: summary, running: false, history: getDuHastMuchHistory() as DhmRecord[] });
  } catch (err) {
    const stopped = controller.signal.aborted;
    patchDhm({ running: false, error: stopped ? null : err instanceof Error ? err.message : "Scan failed" });
  } finally {
    abort = null;
  }
}

export function stopDhm(): void {
  abort?.abort();
}

/** Show a scan from history again. */
export function showDhmRecord(record: DhmRecord): void {
  patchDhm({
    path: record.path,
    depth: record.depth,
    top: record.top ?? null,
    latest: record.latest,
    results: record.results,
    meta: { totalSize: record.total_size, totalFiles: record.total_files, elapsedSeconds: record.elapsed_seconds },
    shown: { path: record.path, latest: record.latest, top: record.top ?? null },
    error: null,
  });
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

/** The du-hast-much table for the current results. Empty before any scan. */
export function dhmLines(state: Pick<DhmState, "results" | "meta" | "running" | "shown">): string[] {
  const { results, meta, running, shown } = state;
  if (!shown || (results.length === 0 && !running)) return [];
  const latest = shown.latest;
  const lines = [
    `${ESC}1;36mdu-hast-much${RESET} — ${running ? "scanning" : "scanned"} ${ESC}36m${shown.path}${RESET}`,
    "",
  ];
  if (results.length === 0) return lines;

  // Results stream in as each folder finishes; the order is ours to impose.
  const sorted = [...results].sort(latest ? (a, b) => b.latest_mtime - a.latest_mtime : (a, b) => b.size - a.size);
  const rows = shown.top ? sorted.slice(0, shown.top) : sorted;
  const total = meta?.totalSize ?? results.reduce((sum, r) => sum + r.size, 0);
  const largest = rows.reduce((max, r) => Math.max(max, r.size), 0) || 1;

  const columns: Column[] = latest
    ? [
        { title: "#", width: 3, right: true },
        { title: "Directory", width: 26 },
        { title: "Size", width: 9, right: true },
        { title: "Files", width: 7, right: true },
        { title: "Avg size", width: 9, right: true },
        { title: "Latest", width: 9 },
      ]
    : [
        { title: "#", width: 3, right: true },
        { title: "Directory", width: 30 },
        { title: "Size", width: 9, right: true },
        { title: "% Total", width: 7, right: true },
        { title: "Usage", width: 12 },
      ];

  lines.push(`${ESC}1m${latest ? "Recently modified directories" : "Disk usage by directory"}${RESET}`);
  lines.push(rule(columns, "┌", "┬", "┐"));
  lines.push(row(columns, columns.map((c) => ({ text: c.title, color: `${ESC}2m` }))));
  lines.push(rule(columns, "├", "┼", "┤"));
  rows.forEach((r, i) => {
    const big = r.size > 1 << 30 ? `${ESC}1;33m` : undefined;
    if (latest) {
      // Lots of small new files is the pattern worth noticing.
      const swarm = r.avg_file_size < 100 * 1024 && r.files > 50 ? `${ESC}1;31m` : undefined;
      lines.push(
        row(columns, [
          { text: String(i + 1) },
          { text: r.name, color: swarm },
          { text: formatBytes(r.size), color: big },
          { text: r.files.toLocaleString() },
          { text: formatBytes(r.avg_file_size) },
          { text: timeAgo(r.latest_mtime) },
        ]),
      );
    } else {
      const share = total > 0 ? (r.size / total) * 100 : 0;
      lines.push(
        row(columns, [
          { text: String(i + 1) },
          { text: r.name },
          { text: formatBytes(r.size), color: big },
          { text: `${share.toFixed(1)}%`, color: share > 20 ? `${ESC}1;33m` : undefined },
          { text: bar(r.size / largest, 12), color: `${ESC}36m` },
        ]),
      );
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
  return lines;
}
