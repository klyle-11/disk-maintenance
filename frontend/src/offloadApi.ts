/**
 * Offloading: moving folders to an external drive, verified, and the catalog
 * of what went where. These are Tauri commands only: the older Python backend
 * has no offload.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./desktop";

export type RemoveMode = "keep" | "trash" | "delete";

export interface OffloadProblem {
  path: string;
  /** failed, skipped, kept (an original not removed), missing or damaged (on the drive) */
  kind: string;
  message: string;
}

export interface Removal {
  checked: number;
  removed_files: number;
  removed_bytes: number;
  freed_bytes: number;
  kept_files: number;
  already_gone: number;
  folders_removed: number;
  folders_left: number;
  trashed: boolean;
}

export interface OffloadReport {
  job_id: string;
  store_id: string;
  store_label: string;
  source: string;
  dest: string;
  outcome: "complete" | "incomplete" | "cancelled";
  stopped: string | null;
  items_seen: number;
  bytes_seen: number;
  copied_files: number;
  copied_bytes: number;
  already_files: number;
  already_bytes: number;
  verified_files: number;
  verified_bytes: number;
  failed: number;
  skipped: number;
  removal: Removal;
  problems: OffloadProblem[];
  problems_total: number;
}

export interface ReleaseReport {
  job_id: string;
  outcome: "complete" | "incomplete" | "cancelled";
  stopped: string | null;
  removal: Removal;
  problems: OffloadProblem[];
  problems_total: number;
}

export interface CheckReport {
  job_id: string;
  outcome: "ok" | "problems" | "cancelled";
  checked: number;
  ok: number;
  missing: number;
  damaged: number;
  bytes_read: number;
  problems: OffloadProblem[];
  problems_total: number;
}

export interface RestoreReport {
  job_id: string;
  target: string;
  outcome: "complete" | "incomplete" | "cancelled";
  stopped: string | null;
  restored_files: number;
  restored_bytes: number;
  already_files: number;
  failed: number;
  problems: OffloadProblem[];
  problems_total: number;
}

export interface ImportReport {
  store_id: string;
  store_label: string;
  jobs_added: number;
  jobs_known: number;
  files_added: number;
  rows_rejected: number;
}

export interface OffloadProgress {
  phase: "starting" | "counting" | "copying" | "removing" | "checking" | "restoring";
  files_total: number;
  bytes_total: number;
  files_done: number;
  bytes_done: number;
  problems: number;
  current_path: string;
}

/** What a source and destination look like before a run. */
export interface OffloadPlan {
  source: string;
  source_kind: "dir" | "file";
  store_root: string;
  store_id: string | null;
  store_label: string;
  free_bytes: number;
  files: number;
  bytes: number;
}

export interface OffloadStore {
  id: string;
  label: string;
  last_path: string;
  created_at: string;
  last_seen_at: string;
  /** Where it is right now, or null when its drive isn't connected. */
  path: string | null;
  free_bytes: number | null;
}

export interface OffloadJob {
  id: string;
  store_id: string;
  host: string;
  source_path: string;
  source_kind: "dir" | "file";
  rel_base: string;
  state: "running" | "complete" | "incomplete";
  started_at: string;
  finished_at: string | null;
  last_checked_at: string | null;
  last_check_problems: number | null;
  verified_files: number;
  verified_bytes: number;
  removed_files: number;
  removed_bytes: number;
  problem_files: number;
  damaged_files: number;
}

export interface OffloadCatalog {
  host: string;
  stores: OffloadStore[];
  jobs: OffloadJob[];
}

export interface OffloadHit {
  store_id: string;
  store_label: string;
  job_id: string;
  host: string;
  source_path: string;
  rel_base: string;
  rel_path: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime_ns: number | null;
  source_removed: boolean;
  drive_state: string | null;
}

export interface OffloadFileRow {
  rel_path: string;
  kind: string;
  state: string;
  error: string | null;
  drive_state: string | null;
}

export interface OffloadCandidate {
  path: string;
  bytes: number;
  files: number;
  idle_days: number;
  /** local: only here. copied: verified on a drive, originals still here. */
  status: "local" | "copied";
  job_id: string | null;
  store_label: string | null;
}

export interface Volume {
  mount: string;
  name: string;
  total_bytes: number;
  free_bytes: number;
}

/** Offload exists in the Tauri app only. */
export const offloadAvailable = isTauri;

function command<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri) return Promise.reject(new Error("Offload needs the desktop app."));
  return invoke<T>(name, args).catch((err) => {
    throw err instanceof Error ? err : new Error(String(err));
  });
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A long run: progress arrives on a channel, the command resolves with the
 * report. Aborting `signal` asks the backend to stop; a stopped run still
 * resolves, with a report that says how far it got.
 */
async function run<R>(name: string, args: Record<string, unknown>, onProgress: (p: OffloadProgress) => void, signal?: AbortSignal): Promise<R> {
  if (!isTauri) throw new Error("Offload needs the desktop app.");
  const requestId = newRequestId();
  let finished = false;
  const channel = new Channel<OffloadProgress>();
  channel.onmessage = (event) => {
    if (!finished) onProgress(event);
  };
  const onAbort = () => {
    invoke("cancel", { requestId }).catch(() => {});
  };
  // A cancel pressed before the run starts must still reach it.
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort);
  try {
    return await invoke<R>(name, { ...args, requestId, onProgress: channel });
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    finished = true;
    signal?.removeEventListener("abort", onAbort);
  }
}

export const planOffload = (source: string, dest: string) => command<OffloadPlan>("offload_plan", { source, dest });

export const runOffload = (source: string, dest: string, remove: RemoveMode, onProgress: (p: OffloadProgress) => void, signal?: AbortSignal) =>
  run<OffloadReport>("offload_run", { source, dest, remove }, onProgress, signal);

export const releaseOffload = (jobId: string, remove: RemoveMode, onProgress: (p: OffloadProgress) => void, signal?: AbortSignal) =>
  run<ReleaseReport>("offload_release", { jobId, remove }, onProgress, signal);

export const checkOffload = (jobId: string, onProgress: (p: OffloadProgress) => void, signal?: AbortSignal) =>
  run<CheckReport>("offload_check", { jobId }, onProgress, signal);

export const restoreOffload = (jobId: string, only: string | null, to: string | null, onProgress: (p: OffloadProgress) => void, signal?: AbortSignal) =>
  run<RestoreReport>("offload_restore", { jobId, only, to }, onProgress, signal);

export const getOffloadCatalog = () => command<OffloadCatalog>("offload_catalog");
export const searchOffloaded = (query: string) => command<OffloadHit[]>("offload_search", { query });
export const getOffloadProblems = (jobId: string) => command<OffloadFileRow[]>("offload_problems", { jobId });
export const getOffloadCandidates = (scanId: string) => command<OffloadCandidate[]>("offload_candidates", { scanId });
export const importOffloadStore = (path: string) => command<ImportReport>("offload_import", { path });
export const forgetOffload = (jobId: string) => command<void>("offload_forget", { jobId });
export const getVolumes = () => command<Volume[]>("offload_volumes");
