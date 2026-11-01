/**
 * Comparison sessions: a small control window (paths, filters, save) and the
 * source/target pair of tree windows, which share one filter, one set of open
 * folders and one scroll position through the session here.
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
import { closeWindow, openWindow, wmDispatch, wmStore } from "../wm/state";
import { errorMessage, snapshotProblem } from "../windows/common";
import { folderKeys, topLevelFolders, visibleItems, type Side, type StatusFilter } from "../windows/compareTree";
import { isReady, setProblem, upsertSnapshot } from "./app";
import { ask, tell } from "../desktop";

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
}

export const EMPTY_SUMMARY: ComparisonSummary = {
  identical: 0,
  modified: 0,
  missingFromTarget: 0,
  extraInTarget: 0,
  totalSourceSize: 0,
  totalTargetSize: 0,
};

const store = createStore<Record<string, CompareSession>>({});
let counter = 0;

/** Ids of the snapshots that have windows open, space-separated (a stable value to select). */
export function useOpenCompareSnapshots(): string {
  return useStore(store, (s) =>
    Object.values(s)
      .map((x) => x.snapshotId)
      .filter(Boolean)
      .sort()
      .join(" "),
  );
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
  };
}

export const pairId = (id: string) => `${id}:pair`;

export function newCompare(): void {
  const id = `cmp-${++counter}`;
  store.set((all) => ({ ...all, [id]: blank(id) }));
  openWindow("compare", id, { ref: id });
}

export function openCompareSnapshot(snapshot: ComparisonSnapshot): void {
  const existing = Object.values(store.get()).find((s) => s.snapshotId === snapshot.id);
  if (existing && wmStore.get().units.some((u) => u.id === existing.id)) {
    wmDispatch({ type: "focus", id: existing.id });
    return;
  }
  const result = fromSnapshot(snapshot);
  const id = `cmp-${++counter}`;
  store.set((all) => ({
    ...all,
    [id]: {
      ...blank(id),
      phase: result ? "results" : "setup",
      paths: { source: snapshot.rootPath, target: snapshot.targetPath || "" },
      result,
      snapshotId: snapshot.id,
      expanded: topLevelFolders(result?.tree ?? []),
    },
  }));
  openWindow("compare", id, { ref: id });
  if (result) openWindow("cmp-pair", pairId(id), { ref: id, parent: id });
  if (isReady()) void refreshCompare(id);
}

export async function runCompare(id: string): Promise<void> {
  const session = store.get()[id];
  if (!session) return;
  const source = session.paths.source.trim();
  const target = session.paths.target.trim();
  if (!source || !target) return;
  patchCompare(id, { phase: "comparing", error: null });
  try {
    const result = await compareDirectories(source, target, session.deepScan);
    patchCompare(id, {
      result,
      phase: "results",
      filter: "all",
      scrollTop: 0,
      expanded: topLevelFolders(result.tree),
    });
    openWindow("cmp-pair", pairId(id), { ref: id, parent: id });
  } catch (err) {
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
    void tell(`Couldn't save the comparison: ${errorMessage(err)}`);
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

export async function closeCompare(id: string): Promise<void> {
  const session = store.get()[id];
  if (session?.phase === "results" && !session.snapshotId) {
    if (!(await ask("This comparison isn't saved. Close it anyway?", "Close"))) return;
  }
  closeWindow(id);
  store.set((all) => {
    const next = { ...all };
    delete next[id];
    return next;
  });
}

export function forgetCompareSnapshot(snapshotId: string): void {
  for (const s of Object.values(store.get())) {
    if (s.snapshotId === snapshotId) {
      closeWindow(s.id);
      store.set((all) => {
        const next = { ...all };
        delete next[s.id];
        return next;
      });
    }
  }
}
