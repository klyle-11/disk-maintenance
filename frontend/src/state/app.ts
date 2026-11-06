/**
 * App-wide state: the backend connection, saved snapshots, space tips and the
 * skin. Read by many windows at once.
 */
import {
  deleteSnapshot as apiDeleteSnapshot,
  formatBytes,
  getDisks,
  getSnapshots,
  getSpaceTips,
  type ComparisonSnapshot,
  type DiskSpace,
  type SpaceTips,
} from "../api";
import type { BackendStatus } from "../electron.d";
import { readPanels, readSkin, savePanels, saveSkin, type Panel, type Skin } from "../skins";
import { createStore, useStore } from "../store";
import { desktop } from "../desktop";

export interface AppState {
  /** True once /api/health answers; null while we don't know yet. */
  connected: boolean | null;
  /** The API version of a backend that answered but is too old to use. */
  outdated: number | null;
  backend: BackendStatus | null;
  snapshots: ComparisonSnapshot[];
  snapshotsLoading: boolean;
  snapshotsError: string | null;
  /** Why a snapshot couldn't be refreshed (e.g. its drive is unplugged), by id. */
  problems: Record<string, string>;
  tips: SpaceTips | null;
  /** Free space on each disk, the home disk first (empty until loaded). */
  disks: DiskSpace[];
  skin: Skin;
  /** Each skin's inside: a dark display or white paper. */
  panels: Record<Skin, Panel>;
}

export const appStore = createStore<AppState>({
  connected: null,
  outdated: null,
  backend: null,
  snapshots: [],
  snapshotsLoading: true,
  snapshotsError: null,
  problems: {},
  tips: null,
  disks: [],
  skin: readSkin(),
  panels: readPanels(),
});

export function useApp<S>(select: (state: AppState) => S): S {
  return useStore(appStore, select);
}

/** How many items the library holds, and the scans' total size. */
export function useLibrarySummary(): string {
  return useApp((s) => {
    const list = s.snapshots.filter((x) => x && x.id);
    const total = list.reduce((sum, x) => sum + (x.snapshotType === "comparison" ? 0 : x.totalSizeBytes || 0), 0);
    return `${list.length} saved${total ? ` · ${formatBytes(total)}` : ""}`;
  });
}

export function patchApp(patch: Partial<AppState>): void {
  appStore.set((s) => ({ ...s, ...patch }));
}

/** The backend is answering. */
export function isReady(): boolean {
  return appStore.get().connected === true;
}

/** The backend failed to start (or, outside Electron, stopped answering). */
export function backendFailed(state: AppState): boolean {
  if (state.outdated !== null) return true;
  if (state.connected === true) return false;
  return state.backend ? state.backend.state === "error" : state.connected === false;
}

export function setSkin(skin: Skin): void {
  saveSkin(skin);
  patchApp({ skin });
}

/** Switch the current skin's inside between dark and white. */
export function setPanel(panel: Panel): void {
  const { skin, panels } = appStore.get();
  const next = { ...panels, [skin]: panel };
  savePanels(next);
  patchApp({ panels: next });
}

export async function loadSnapshots(): Promise<void> {
  patchApp({ snapshotsLoading: true, snapshotsError: null });
  try {
    const snapshots = await getSnapshots();
    patchApp({ snapshots, snapshotsLoading: false });
  } catch (err) {
    console.error("[Snapshots] Failed to load snapshots:", err);
    patchApp({ snapshotsLoading: false, snapshotsError: err instanceof Error ? err.message : "Failed to load snapshots" });
  }
}

/** Add or replace a snapshot in the library (newest first when new). */
export function upsertSnapshot(snapshot: ComparisonSnapshot): void {
  appStore.set((s) => ({
    ...s,
    snapshots: s.snapshots.some((x) => x.id === snapshot.id)
      ? s.snapshots.map((x) => (x.id === snapshot.id ? snapshot : x))
      : [snapshot, ...s.snapshots],
  }));
}

export async function removeSnapshot(id: string): Promise<void> {
  await apiDeleteSnapshot(id);
  appStore.set((s) => {
    const problems = { ...s.problems };
    delete problems[id];
    return { ...s, snapshots: s.snapshots.filter((x) => x.id !== id), problems };
  });
}

export function setProblem(id: string, problem: string | null): void {
  appStore.set((s) => {
    if ((s.problems[id] ?? null) === problem) return s;
    const problems = { ...s.problems };
    if (problem) problems[id] = problem;
    else delete problems[id];
    return { ...s, problems };
  });
}

export async function loadTips(): Promise<SpaceTips | null> {
  try {
    const tips = await getSpaceTips();
    patchApp({ tips });
    return tips;
  } catch {
    return appStore.get().tips;
  }
}

export async function loadDisks(): Promise<void> {
  try {
    patchApp({ disks: await getDisks() });
  } catch {
    // Keep the last list; the next refresh tries again.
  }
}

/** Restart the backend after a failure (Electron only). */
export async function retryBackend(): Promise<void> {
  patchApp({ connected: null });
  const status = await desktop?.retryBackend?.();
  if (status) patchApp({ backend: status });
}
