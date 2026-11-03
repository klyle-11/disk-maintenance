/**
 * The di terminal: output, the line being typed, and history. Lives here so
 * the command-suggestions window can fill in or run commands for the
 * terminal window.
 */
import { DiConfirmError, getDiCommands, splitCommandLine, startDiRun, streamDiRun, type DiCommand } from "../api";
import { parseAnsi, type AnsiSegment, type AnsiStyle } from "../ansi";
import { createStore, useStore } from "../store";

const MAX_LINES = 4000;
const HISTORY_KEY = "di-history";

export interface TermLine {
  id: number;
  segments: AnsiSegment[];
}

export interface DiState {
  lines: TermLine[];
  /** The line di is still writing (a spinner redraws it in place). */
  live: string;
  input: string;
  running: boolean;
  commands: DiCommand[];
  history: string[];
  historyIndex: number;
  /** Terminal width in characters, measured by the terminal window. */
  columns: number;
}

function readHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export const diStore = createStore<DiState>({
  lines: [],
  live: "",
  input: "",
  running: false,
  commands: [],
  history: readHistory(),
  historyIndex: -1,
  columns: 100,
});

export function useDi<S>(select: (s: DiState) => S): S {
  return useStore(diStore, select);
}

const patch = (p: Partial<DiState>) => diStore.set((s) => ({ ...s, ...p }));

let nextId = 0;
let partial = "";
let style: AnsiStyle = {};
let abort: AbortController | null = null;

/** Resolve a terminal line's \r redraws to what ends up on screen. */
export function visible(text: string): string {
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  const cr = line.lastIndexOf("\r");
  return cr >= 0 ? line.slice(cr + 1) : line;
}

function append(segmentLists: AnsiSegment[][]): void {
  if (segmentLists.length === 0) return;
  const added = segmentLists.map((segments) => ({ id: nextId++, segments }));
  diStore.set((s) => {
    const lines = [...s.lines, ...added];
    return { ...s, lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines };
  });
}

function note(text: string, noteStyle: AnsiStyle = { dim: true }): void {
  append([[{ text, style: noteStyle }]]);
}

function parseLine(text: string): AnsiSegment[] {
  const parsed = parseAnsi(visible(text), style);
  style = parsed.end;
  return parsed.segments;
}

function feed(text: string): void {
  const parts = (partial + text).split("\n");
  partial = parts.pop() ?? "";
  append(parts.map(parseLine));
  patch({ live: partial });
}

function flush(): void {
  if (visible(partial).trim()) append([parseLine(partial)]);
  partial = "";
  style = {};
  patch({ live: "" });
}

function remember(text: string): void {
  const history = [text, ...diStore.get().history.filter((h) => h !== text)].slice(0, 50);
  patch({ history, historyIndex: -1 });
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // History just won't survive a restart.
  }
}

export async function loadDiCommands(): Promise<void> {
  try {
    patch({ commands: await getDiCommands() });
  } catch {
    // The suggestions window just stays empty until the next try.
  }
}

/** Run a command line; anything that deletes or schedules something asks first. */
export async function runDi(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || diStore.get().running) return;
  let args = splitCommandLine(trimmed);
  if (args[0] === "di") args = args.slice(1);
  remember(trimmed);
  patch({ input: "" });
  if (args[0] === "clear" || args[0] === "cls") {
    patch({ lines: [] });
    return;
  }

  append([[
    { text: "di› ", style: { fg: "var(--lcd-accent)", bold: true } },
    { text: args.join(" "), style: { bold: true } },
  ]]);
  patch({ running: true });
  const controller = new AbortController();
  abort = controller;
  try {
    const columns = diStore.get().columns;
    let runId: string;
    try {
      runId = await startDiRun(args, columns);
    } catch (err) {
      if (!(err instanceof DiConfirmError)) throw err;
      if (!window.confirm(`${err.message}.\n\nRun “di ${args.join(" ")}” anyway?`)) {
        note("not run");
        return;
      }
      runId = await startDiRun(args, columns, true);
    }
    if (controller.signal.aborted) return;
    await streamDiRun(
      runId,
      {
        onOutput: feed,
        onExit: (code, elapsed) => {
          flush();
          if (code === 0) note(`✓ ${elapsed.toFixed(1)}s`);
          else note(`exit ${code} · ${elapsed.toFixed(1)}s`, { fg: "var(--ansi-red)" });
        },
      },
      controller.signal,
    );
  } catch (err) {
    flush();
    if (controller.signal.aborted) note("^C stopped", { fg: "var(--ansi-yellow)" });
    else note(err instanceof Error ? err.message : String(err), { fg: "var(--ansi-red)" });
  } finally {
    abort = null;
    patch({ running: false });
  }
}

export function stopDi(): void {
  abort?.abort();
}

export function clearDi(): void {
  patch({ lines: [] });
}

export function setDiInput(input: string): void {
  patch({ input });
}

/** Step through history: +1 is older, -1 is newer. */
export function diHistory(step: 1 | -1): void {
  const { history, historyIndex } = diStore.get();
  const index = Math.max(-1, Math.min(historyIndex + step, history.length - 1));
  patch({ historyIndex: index, input: index >= 0 ? history[index] : "" });
}

export function setDiColumns(columns: number): void {
  if (columns !== diStore.get().columns) patch({ columns });
}
