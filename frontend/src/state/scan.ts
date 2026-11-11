/**
 * The scan window's session: the folder being scanned (or the saved snapshot
 * being shown), its findings and file types, and which section is open.
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
import { closeWindow, openWindow } from "../wm/state";
import { errorMessage, snapshotProblem } from "../windows/common";
import { isReady, setProblem, upsertSnapshot } from "./app";
import { ask, notify } from "../desktop";

export type ScanPhase = "setup" | "scanning" | "results" | "error";

/** The scan window's sections; one is open at a time and fills the window. */
export type ScanSection = "findings" | "types" | "library";

/** The scan window and its session share this id. */
export const SCAN = "scan";

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
  section: ScanSection;
}

const store = createStore<Record<string, ScanSession>>({ [SCAN]: blank(SCAN) });
const aborts = new Map<string, AbortController>();

/** The snapshot the scan window is showing, if any. */
export function useOpenScanSnapshot(): string | null {
  return useStore(store, (s) => s[SCAN]?.snapshotId ?? null);
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
    section: "library",
  };
}

/** Results nobody saved would be lost by showing something else. */
function unsaved(session: ScanSession | undefined): boolean {
  return !!session && session.phase === "results" && !!session.scanId && !session.snapshotId;
}

/** Before the scan window shows something else: ask if that would stop a scan or lose results. */
async function mayReplace(session: ScanSession | undefined, action: string): Promise<boolean> {
  if (session?.phase === "scanning") return ask(`A scan of ${session.path} is still running. Stop it and ${action}?`);
  if (unsaved(session)) return ask(`This scan isn't saved as a snapshot. ${action[0].toUpperCase()}${action.slice(1)} anyway?`);
  return true;
}

/** A path as a comparable key: Windows paths ignore case and slash direction. */
export function pathKey(path: string): string {
  const windows = /^[a-z]:|\\/i.test(path);
  const key = windows ? path.replace(/\//g, "\\").toLowerCase() : path;
  return key.length > 1 ? key.replace(/[\\/]+$/, "") : key;
}

/** The newest saved scan of this folder, if there is one. */
export function savedScanOf(snapshots: ComparisonSnapshot[], path: string): ComparisonSnapshot | undefined {
  const key = pathKey(path);
  let newest: ComparisonSnapshot | undefined;
  for (const s of snapshots) {
    if (!s?.id || s.snapshotType === "comparison" || pathKey(s.rootPath) !== key) continue;
    if (!newest || Date.parse(s.savedAt) > Date.parse(newest.savedAt)) newest = s;
  }
  return newest;
}

/** Send a folder to the scan window and scan it there. */
export async function scanFolder(path: string): Promise<void> {
  if (!(await mayReplace(store.get()[SCAN], `scan ${path} instead`))) return;
  cancelScan(SCAN);
  store.set((all) => ({ ...all, [SCAN]: { ...blank(SCAN), path } }));
  newScan();
  if (isReady()) void startScan(SCAN);
}

/** Open (or flash) the scan window. */
export function newScan(): void {
  openWindow("scan", SCAN, { ref: SCAN });
}

/** Clear the results, ready for another folder (asks first if they aren't saved). */
export async function resetScan(): Promise<void> {
  const session = store.get()[SCAN];
  if (unsaved(session) && !(await ask("This scan isn't saved as a snapshot. Start a new one anyway?"))) return;
  cancelScan(SCAN);
  store.set((all) => ({ ...all, [SCAN]: { ...blank(SCAN), path: session?.path ?? "" } }));
}

/** Show a saved snapshot in the scan window, then bring it up to date. */
export async function openScanSnapshot(snapshot: ComparisonSnapshot): Promise<void> {
  const current = store.get()[SCAN];
  if (current?.snapshotId !== snapshot.id) {
    if (!(await mayReplace(current, "open the other one"))) return;
    cancelScan(SCAN);
    store.set((all) => ({
      ...all,
      [SCAN]: {
        ...blank(SCAN),
        phase: "results",
        path: snapshot.rootPath,
        info: snapshot.scanInfo,
        findings: snapshot.findings ?? [],
        extensions: snapshot.extensions ?? [],
        snapshotId: snapshot.id,
        savedAt: snapshot.savedAt,
        section: "findings",
      },
    }));
  }
  newScan();
  if (isReady()) void refreshScan(SCAN);
}

export async function startScan(id: string): Promise<void> {
  const session = store.get()[id];
  const root = session?.path.trim();
  if (!root) return;
  cancelScan(id);
  const controller = new AbortController();
  aborts.set(id, controller);
  // A cancelled run must not write over whatever the window shows next.
  const live = () => aborts.get(id) === controller;
  patchScan(id, { phase: "scanning", error: null, progress: null, log: [`Starting scan of ${root}`] });
  try {
    const result = await scanWithProgress(
      root,
      (event) => {
        if (!live()) return;
        patchScan(id, (s) => ({
          progress: event,
          log: [...s.log.slice(-199), `[${event.progress_percent}%] ${event.message}`],
        }));
      },
      controller.signal,
    );
    if (!live()) return;
    patchScan(id, { info: result, scanId: result.scanId, phase: "results", loadingResults: true, section: "findings" });
    const [findings, extensions] = await Promise.all([getFindings(result.scanId), getExtensionSummary(result.scanId)]);
    if (!live()) return;
    aborts.delete(id);
    patchScan(id, { findings, extensions, loadingResults: false });
  } catch (err) {
    if (!live()) return;
    aborts.delete(id);
    patchScan(id, { phase: "error", error: errorMessage(err), loadingResults: false });
  }
}

/** Stop a scan (or the loading of its results) and go back to the folder bar. */
export function cancelScan(id: string): void {
  const controller = aborts.get(id);
  if (!controller) return;
  aborts.delete(id);
  controller.abort();
  patchScan(id, (s) => (s.phase === "scanning" ? { phase: "setup", loadingResults: false } : { loadingResults: false }));
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
    await notify(`Couldn't save the snapshot: ${errorMessage(err)}`);
  }
}

/** Re-scan a snapshot's folder and update it. Keeps the saved numbers on failure. */
export async function refreshScan(id: string): Promise<void> {
  const session = store.get()[id];
  const snapshotId = session?.snapshotId;
  if (!snapshotId || session.busy) return;
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

/** Close the scan window, asking first if it has unsaved results. */
export async function closeScan(): Promise<void> {
  const session = store.get()[SCAN];
  if (unsaved(session) && !(await ask("This scan isn't saved as a snapshot. Close it anyway?"))) return;
  cancelScan(SCAN);
  closeWindow(SCAN);
  store.set((all) => ({ ...all, [SCAN]: { ...blank(SCAN), path: session?.path ?? "" } }));
}

/** A snapshot was deleted: stop showing it, keeping its numbers as an unsaved view. */
export function forgetScanSnapshot(snapshotId: string): void {
  const session = store.get()[SCAN];
  if (session?.snapshotId === snapshotId) {
    store.set((all) => ({ ...all, [SCAN]: { ...blank(SCAN), path: session.path } }));
  }
}
