/**
 * The compare window's session: the two folders, the result, and how it is
 * shown (filter, open folders, the one scroll position both trees share).
 */
import {
  compareDirectories,
  saveComparisonSnapshot,
  updateComparisonSnapshot,
  type ComparisonItem,
  type ComparisonSnapshot,
  type ComparisonSummary,
} from "../api";
import { createStore, useStore } from "../store";
import { closeWindow, openWindow } from "../wm/state";
import { errorMessage, snapshotProblem } from "../windows/common";
import { folderKeys, topLevelFolders, visibleItems, type Side, type StatusFilter } from "../windows/compareTree";
import { isReady, setProblem, upsertSnapshot } from "./app";
import { pathKey } from "./scan";
import { ask, notify } from "../desktop";

export interface CompareResult {
  comparisonId: string;
  sourcePath: string;
  targetPath: string;
  summary: ComparisonSummary;
  tree: ComparisonItem[];
}

export interface CompareSession {
  id: string;
  phase: "setup" | "comparing" | "results" | "error";
  paths: Record<Side, string>;
  deepScan: boolean;
  error: string | null;
  result: CompareResult | null;
  snapshotId: string | null;
  busy: "saving" | "refreshing" | null;
  problem: string | null;
  filter: StatusFilter;
  diffOnly: boolean;
  mode: "tree" | "paths";
  expanded: Set<string>;
  scrollTop: number;
  hover: string | null;
  /** The folder fields; folded away once there are results. */
  foldersOpen: boolean;
}

/** The compare window and its session share this id. */
export const COMPARE = "compare";

export const EMPTY_SUMMARY: ComparisonSummary = {
  identical: 0,
  modified: 0,
  missingFromTarget: 0,
  extraInTarget: 0,
  totalSourceSize: 0,
  totalTargetSize: 0,
};

const store = createStore<Record<string, CompareSession>>({ [COMPARE]: blank(COMPARE) });

/** Bumped by every run, so a superseded comparison's late result is dropped. */
let compareToken = 0;

/** The snapshot the compare window is showing, if any. */
export function useOpenCompareSnapshot(): string | null {
  return useStore(store, (s) => s[COMPARE]?.snapshotId ?? null);
}

export function useCompare(id: string | undefined): CompareSession | undefined {
  return useStore(store, (s) => (id ? s[id] : undefined));
}

export function patchCompare(
  id: string,
  patch: Partial<CompareSession> | ((s: CompareSession) => Partial<CompareSession>),
): void {
  store.set((all) => {
    const current = all[id];
    if (!current) return all;
    return { ...all, [id]: { ...current, ...(typeof patch === "function" ? patch(current) : patch) } };
  });
}

function fromSnapshot(s: ComparisonSnapshot): CompareResult | null {
  if (!s.comparison) return null;
  return {
    comparisonId: s.scanId,
    sourcePath: s.rootPath,
    targetPath: s.targetPath || "",
    summary: s.comparisonSummary || EMPTY_SUMMARY,
    tree: s.comparison,
  };
}

function blank(id: string): CompareSession {
  return {
    id,
    phase: "setup",
    paths: { source: "", target: "" },
    deepScan: false,
    error: null,
    result: null,
    snapshotId: null,
    busy: null,
    problem: null,
    filter: "all",
    diffOnly: false,
    mode: "tree",
    expanded: new Set(),
    scrollTop: 0,
    hover: null,
    foldersOpen: true,
  };
}

/** Results nobody saved would be lost by showing something else. */
function unsaved(session: CompareSession | undefined): boolean {
  return !!session && session.phase === "results" && !session.snapshotId;
}

/** Open (or flash) the compare window. */
export function newCompare(): void {
  openWindow("compare", COMPARE, { ref: COMPARE });
}

/** Show a saved comparison in the compare window, then bring it up to date. */
export async function openCompareSnapshot(snapshot: ComparisonSnapshot): Promise<void> {
  const current = store.get()[COMPARE];
  if (current?.snapshotId !== snapshot.id) {
    if (unsaved(current) && !(await ask("This comparison isn't saved. Open the other one anyway?"))) return;
    compareToken++;
    const result = fromSnapshot(snapshot);
    store.set((all) => ({
      ...all,
      [COMPARE]: {
        ...blank(COMPARE),
        phase: result ? "results" : "setup",
        paths: { source: snapshot.rootPath, target: snapshot.targetPath || "" },
        result,
        snapshotId: snapshot.id,
        expanded: topLevelFolders(result?.tree ?? []),
        foldersOpen: !result,
      },
    }));
  }
  newCompare();
  if (isReady()) void refreshCompare(COMPARE);
}

/**
 * Start a comparison from somewhere else (a scan, du-hast-much, a saved
 * scan): `source` on the left, and `target` on the right when it's known,
 * which runs it straight away. Without a target the window opens with the
 * folder fields ready for the other side.
 */
export async function compareWith(source: string, target?: string): Promise<void> {
  const current = store.get()[COMPARE];
  const same =
    !!current &&
    current.phase === "results" &&
    pathKey(current.paths.source) === pathKey(source) &&
    pathKey(current.paths.target) === pathKey(target ?? "");
  if (same) return newCompare();
  if (unsaved(current) && !(await ask("This comparison isn't saved. Start another anyway?"))) return;
  compareToken++;
  store.set((all) => ({
    ...all,
    [COMPARE]: { ...blank(COMPARE), deepScan: current?.deepScan ?? false, paths: { source, target: target ?? "" } },
  }));
  newCompare();
  if (target && isReady()) void runCompare(COMPARE);
}

/** The folder waiting in the compare window for a second one, if any. */
function waitingSource(s: CompareSession | undefined): string | null {
  const source = s?.paths.source.trim();
  return s && source && !s.paths.target.trim() && !s.result && s.phase !== "comparing" ? source : null;
}

/**
 * Add one folder to the comparison: it becomes the target when a source is
 * waiting for one (and the comparison runs), otherwise it starts a new one
 * as the source. So two clicks, on two folders, compare them.
 */
export async function addToCompare(path: string): Promise<void> {
  const source = waitingSource(store.get()[COMPARE]);
  if (source && pathKey(source) !== pathKey(path)) return compareWith(source, path);
  return compareWith(path);
}

export function useWaitingSource(): string | null {
  return useStore(store, (all) => waitingSource(all[COMPARE]));
}

export async function runCompare(id: string): Promise<void> {
  const session = store.get()[id];
  if (!session) return;
  const source = session.paths.source.trim();
  const target = session.paths.target.trim();
  if (!source || !target) return;
  const token = ++compareToken;
  patchCompare(id, { phase: "comparing", error: null });
  try {
    const result = await compareDirectories(source, target, session.deepScan);
    if (token !== compareToken) return;
    patchCompare(id, {
      result,
      phase: "results",
      filter: "all",
      scrollTop: 0,
      expanded: topLevelFolders(result.tree),
      snapshotId: null,
      foldersOpen: false,
    });
  } catch (err) {
    if (token !== compareToken) return;
    patchCompare(id, { phase: "error", error: errorMessage(err) });
  }
}

export async function saveCompare(id: string): Promise<void> {
  const result = store.get()[id]?.result;
  if (!result) return;
  patchCompare(id, { busy: "saving" });
  try {
    const saved = await saveComparisonSnapshot(result.sourcePath, result.targetPath, result.comparisonId);
    upsertSnapshot(saved);
    patchCompare(id, { snapshotId: saved.id, busy: null });
  } catch (err) {
    patchCompare(id, { busy: null });
    await notify(`Couldn't save the comparison: ${errorMessage(err)}`);
  }
}

export async function refreshCompare(id: string): Promise<void> {
  const snapshotId = store.get()[id]?.snapshotId;
  if (!snapshotId) return;
  patchCompare(id, { busy: "refreshing" });
  try {
    const updated = await updateComparisonSnapshot(snapshotId);
    const result = fromSnapshot(updated);
    patchCompare(id, (s) => ({ result: result ?? s.result, problem: null, busy: null }));
    setProblem(snapshotId, null);
    upsertSnapshot(updated);
  } catch (err) {
    console.error("[Comparison] refresh failed:", err);
    const friendly = snapshotProblem(err);
    patchCompare(id, { problem: friendly ?? `Couldn't refresh: ${errorMessage(err)}`, busy: null });
    if (friendly) setProblem(snapshotId, friendly);
  }
}

/** Pick a status filter (again to clear it), opening every folder that holds a match. */
export function chooseFilter(id: string, next: StatusFilter): void {
  patchCompare(id, (s) => {
    const filter = s.filter === next ? "all" : next;
    const tree = s.result?.tree ?? [];
    return {
      filter,
      scrollTop: 0,
      expanded: filter === "all" ? s.expanded : folderKeys(tree, visibleItems(tree, filter, s.diffOnly)),
    };
  });
}

export function toggleFolder(id: string, key: string): void {
  patchCompare(id, (s) => {
    const expanded = new Set(s.expanded);
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    return { expanded };
  });
}

export async function closeCompare(): Promise<void> {
  const session = store.get()[COMPARE];
  if (unsaved(session) && !(await ask("This comparison isn't saved. Close it anyway?"))) return;
  compareToken++;
  closeWindow(COMPARE);
  store.set((all) => ({ ...all, [COMPARE]: { ...blank(COMPARE), paths: session?.paths ?? blank(COMPARE).paths } }));
}

/** A saved comparison was deleted: stop showing it as saved. */
export function forgetCompareSnapshot(snapshotId: string): void {
  if (store.get()[COMPARE]?.snapshotId === snapshotId) patchCompare(COMPARE, { snapshotId: null });
}
