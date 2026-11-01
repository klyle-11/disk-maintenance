/**
 * Scan sessions. Each scan (or saved snapshot) is a small control window plus
 * a findings window and a file-types window; all three read the session here.
 */
import {
  getExtensionSummary,
  getFindings,
  saveSnapshot,
  scanWithProgress,
  updateSnapshot,
  type ComparisonSnapshot,
  type ExtensionSummary,
  type Finding,
  type ProgressEventData,
  type ScanResponse,
} from "../api";
import { createStore, useStore } from "../store";
import { closeWindow, openWindow, wmDispatch, wmStore } from "../wm/state";
import { errorMessage, snapshotProblem } from "../windows/common";
import { isReady, setProblem, upsertSnapshot } from "./app";
import { ask, tell } from "../desktop";

export type ScanPhase = "setup" | "scanning" | "results" | "error";

export interface ScanSession {
  id: string;
  phase: ScanPhase;
  path: string;
  progress: ProgressEventData | null;
  log: string[];
  error: string | null;
  info: ScanResponse | null;
  findings: Finding[];
  extensions: ExtensionSummary[];
  /** The live scan's id on the backend, needed to save it. */
  scanId: string | null;
  snapshotId: string | null;
  savedAt: string | null;
  loadingResults: boolean;
  busy: "saving" | "refreshing" | null;
  problem: string | null;
  category: string;
  query: string;
}

const store = createStore<Record<string, ScanSession>>({});
const aborts = new Map<string, AbortController>();
let counter = 0;

/** Ids of the snapshots that have windows open, space-separated (a stable value to select). */
export function useOpenScanSnapshots(): string {
  return useStore(store, (s) =>
    Object.values(s)
      .map((x) => x.snapshotId)
      .filter(Boolean)
      .sort()
      .join(" "),
  );
}

export function useScan(id: string | undefined): ScanSession | undefined {
  return useStore(store, (s) => (id ? s[id] : undefined));
}

export function patchScan(id: string, patch: Partial<ScanSession> | ((s: ScanSession) => Partial<ScanSession>)): void {
  store.set((all) => {
    const current = all[id];
    if (!current) return all;
    return { ...all, [id]: { ...current, ...(typeof patch === "function" ? patch(current) : patch) } };
  });
}

function blank(id: string): ScanSession {
  return {
    id,
    phase: "setup",
    path: "",
    progress: null,
    log: [],
    error: null,
    info: null,
    findings: [],
    extensions: [],
    scanId: null,
    snapshotId: null,
    savedAt: null,
    loadingResults: false,
    busy: null,
    problem: null,
    category: "all",
    query: "",
  };
}

export const findingsId = (id: string) => `${id}:findings`;
export const typesId = (id: string) => `${id}:types`;

function openResults(id: string): void {
  openWindow("findings", findingsId(id), { ref: id, parent: id });
  openWindow("types", typesId(id), { ref: id, parent: id });
}

/** A new, empty scan: just its control window. */
export function newScan(): void {
  const id = `scan-${++counter}`;
  store.set((all) => ({ ...all, [id]: blank(id) }));
  openWindow("scan", id, { ref: id });
}

/** Show a saved snapshot in windows of its own, then bring it up to date. */
export function openScanSnapshot(snapshot: ComparisonSnapshot): void {
  const existing = Object.values(store.get()).find((s) => s.snapshotId === snapshot.id);
  if (existing && wmStore.get().units.some((u) => u.id === existing.id)) {
    wmDispatch({ type: "focus", id: existing.id });
    return;
  }
  const id = `scan-${++counter}`;
  store.set((all) => ({
    ...all,
    [id]: {
      ...blank(id),
      phase: "results",
      path: snapshot.rootPath,
      info: snapshot.scanInfo,
      findings: snapshot.findings ?? [],
      extensions: snapshot.extensions ?? [],
      snapshotId: snapshot.id,
      savedAt: snapshot.savedAt,
    },
  }));
  openWindow("scan", id, { ref: id });
  openResults(id);
  if (isReady()) void refreshScan(id);
}

export async function startScan(id: string): Promise<void> {
  const session = store.get()[id];
  const root = session?.path.trim();
  if (!root) return;
  const controller = new AbortController();
  aborts.set(id, controller);
  patchScan(id, { phase: "scanning", error: null, progress: null, log: [`Starting scan of ${root}`] });
  try {
    const result = await scanWithProgress(
      root,
      (event) =>
        patchScan(id, (s) => ({
          progress: event,
          log: [...s.log.slice(-199), `[${event.progress_percent}%] ${event.message}`],
        })),
      controller.signal,
    );
    aborts.delete(id);
    patchScan(id, { info: result, scanId: result.scanId, phase: "results", loadingResults: true });
    openResults(id);
    const [findings, extensions] = await Promise.all([getFindings(result.scanId), getExtensionSummary(result.scanId)]);
    patchScan(id, { findings, extensions, loadingResults: false });
  } catch (err) {
    aborts.delete(id);
    if (controller.signal.aborted) {
      patchScan(id, { phase: "setup", loadingResults: false });
      return;
    }
    patchScan(id, { phase: "error", error: errorMessage(err), loadingResults: false });
  }
}

export function cancelScan(id: string): void {
  aborts.get(id)?.abort();
}

export async function saveScan(id: string): Promise<void> {
  const session = store.get()[id];
  if (!session?.scanId || !session.info) return;
  patchScan(id, { busy: "saving" });
  try {
    const saved: ComparisonSnapshot = { ...(await saveSnapshot(session.scanId, session.info.rootPath)), snapshotType: "scan" };
    upsertSnapshot(saved);
    patchScan(id, { snapshotId: saved.id, savedAt: saved.savedAt, busy: null });
  } catch (err) {
    patchScan(id, { busy: null });
    void tell(`Couldn't save the snapshot: ${errorMessage(err)}`);
  }
}

/** Re-scan a snapshot's folder and update it. Keeps the saved numbers on failure. */
export async function refreshScan(id: string): Promise<void> {
  const snapshotId = store.get()[id]?.snapshotId;
  if (!snapshotId) return;
  patchScan(id, { busy: "refreshing" });
  try {
    const updated: ComparisonSnapshot = { ...(await updateSnapshot(snapshotId)), snapshotType: "scan" };
    patchScan(id, {
      findings: updated.findings,
      extensions: updated.extensions,
      info: updated.scanInfo,
      savedAt: updated.savedAt,
      problem: null,
      busy: null,
    });
    setProblem(snapshotId, null);
    upsertSnapshot(updated);
  } catch (err) {
    console.error("[Snapshot] refresh failed:", err);
    const friendly = snapshotProblem(err);
    patchScan(id, { problem: friendly ?? `Couldn't refresh: ${errorMessage(err)}`, busy: null });
    if (friendly) setProblem(snapshotId, friendly);
  }
}

/** Close a scan's windows, asking first if it has unsaved results. */
export async function closeScan(id: string): Promise<void> {
  const session = store.get()[id];
  if (session?.phase === "results" && session.scanId && !session.snapshotId) {
    if (!(await ask("This scan isn't saved as a snapshot. Close it anyway?", "Close"))) return;
  }
  cancelScan(id);
  closeWindow(id);
  store.set((all) => {
    const next = { ...all };
    delete next[id];
    return next;
  });
}

/** Close any scan showing a snapshot that was deleted. */
export function forgetScanSnapshot(snapshotId: string): void {
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
