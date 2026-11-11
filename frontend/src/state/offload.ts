/**
 * Offloading, in one window: move folders to an external drive (MOVE), see
 * what is on which drive and get it back (DRIVES), list everything on a drive
 * whether or not anything was offloaded to it, browse that list and scan
 * from it (CATALOG), and find a file whether or not its drive is plugged in
 * (FIND). One run of any kind at a time: the backend refuses a second.
 */
import {
  catalogDrive,
  checkOffload,
  forgetDriveCatalog,
  listDrive,
  searchDrives,
  forgetOffload,
  getOffloadCandidates,
  getOffloadCatalog,
  getOffloadProblems,
  getVolumes,
  importOffloadStore,
  planOffload,
  releaseOffload,
  restoreOffload,
  runOffload,
  searchOffloaded,
  type CheckReport,
  type DriveHit,
  type DriveListing,
  type OffloadCandidate,
  type OffloadCatalog,
  type OffloadFileRow,
  type OffloadHit,
  type OffloadJob,
  type OffloadProblem,
  type OffloadProgress,
  type OffloadReport,
  type ReleaseReport,
  type RemoveMode,
  type RestoreReport,
  type Volume,
} from "../offloadApi";
import { formatBytes } from "../api";
import { ask, notify } from "../desktop";
import { createStore, useStore } from "../store";
import { errorMessage } from "../windows/common";
import { openWindow } from "../wm/state";
import { loadTips } from "./app";
import { scanFolder } from "./scan";

export type OffloadPhase = "setup" | "planning" | "running" | "done" | "error";

/** What a finished action on a drive has to say. */
export interface ActionResult {
  jobId: string;
  /** A sentence for the result line. */
  headline: string;
  good: boolean;
  lines: string[];
  problems: OffloadProblem[];
  problemsTotal: number;
}

export type OffloadSection = "move" | "drives" | "catalog" | "find";

/** The folder of a drive catalog being looked at. */
export interface Browse {
  storeId: string;
  rel: string;
  listing: DriveListing | null;
  loading: boolean;
  error: string | null;
}

export interface OffloadState {
  section: OffloadSection;
  // -- MOVE --
  phase: OffloadPhase;
  /** Folders to move, in order. */
  sources: string[];
  /** A folder typed or browsed for, when there are no picked candidates. */
  sourceInput: string;
  dest: string;
  remove: RemoveMode;
  /** Folders a scan suggests, and which are ticked. */
  candidates: OffloadCandidate[];
  candidatesFrom: string | null;
  candidatesLoading: boolean;
  picked: Record<string, boolean>;
  volumes: Volume[];
  progress: OffloadProgress | null;
  /** Which of `sources` is running (0-based). */
  running: number;
  reports: OffloadReport[];
  error: string | null;

  // -- DRIVES and FIND --
  catalog: OffloadCatalog | null;
  catalogError: string | null;
  query: string;
  hits: OffloadHit[] | null;
  selectedJob: string | null;
  /** The job an action is running on, and which. */
  action: { jobId: string; kind: "check" | "restore" | "release"; progress: OffloadProgress | null } | null;
  result: ActionResult | null;
  jobProblems: { jobId: string; rows: OffloadFileRow[] } | null;

  // -- CATALOG --
  /** A drive being cataloged, and how far it has got. */
  cataloging: { path: string; progress: OffloadProgress | null } | null;
  catalogNote: { good: boolean; text: string } | null;
  browse: Browse | null;
  driveHits: DriveHit[] | null;
}

const store = createStore<OffloadState>({
  section: "move",
  phase: "setup",
  sources: [],
  sourceInput: "",
  dest: readDest(),
  remove: "keep",
  candidates: [],
  candidatesFrom: null,
  candidatesLoading: false,
  picked: {},
  volumes: [],
  progress: null,
  running: 0,
  reports: [],
  error: null,
  catalog: null,
  catalogError: null,
  query: "",
  hits: null,
  selectedJob: null,
  action: null,
  result: null,
  jobProblems: null,
  cataloging: null,
  catalogNote: null,
  browse: null,
  driveHits: null,
});

let abort: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function readDest(): string {
  try {
    return localStorage.getItem("di.offload.dest") ?? "";
  } catch {
    return "";
  }
}

export function useOffload<S>(select: (state: OffloadState) => S): S {
  return useStore(store, select);
}

export function patchOffload(patch: Partial<OffloadState>): void {
  store.set((s) => ({ ...s, ...patch }));
}

/** A run of some kind is under way. */
export function offloadBusy(s: OffloadState): boolean {
  return s.phase === "running" || s.phase === "planning" || s.action !== null || s.cataloging !== null;
}

export function setDest(dest: string): void {
  patchOffload({ dest });
  try {
    localStorage.setItem("di.offload.dest", dest);
  } catch {
    /* not remembered, then */
  }
}

export async function loadVolumes(): Promise<void> {
  try {
    patchOffload({ volumes: await getVolumes() });
  } catch {
    /* the chips are a convenience */
  }
}

export async function loadCatalog(): Promise<void> {
  try {
    patchOffload({ catalog: await getOffloadCatalog(), catalogError: null });
  } catch (err) {
    patchOffload({ catalogError: errorMessage(err) });
  }
}

/** Open the OFFLOAD window and bring what it shows up to date. */
export function openOffload(): void {
  openWindow("offload");
  void loadVolumes();
  void loadCatalog();
}

/** Open the OFFLOAD window with the folders a scan suggests moving. */
export async function openOffloadForScan(scanId: string, root: string): Promise<void> {
  openOffload();
  if (store.get().phase === "running") return;
  patchOffload({ section: "move", candidatesLoading: true, candidatesFrom: root, candidates: [], picked: {}, phase: "setup", error: null, reports: [] });
  try {
    const candidates = await getOffloadCandidates(scanId);
    patchOffload({ candidates, candidatesLoading: false });
  } catch (err) {
    patchOffload({ candidatesLoading: false, error: errorMessage(err), phase: "error" });
  }
}

export function togglePick(path: string): void {
  store.set((s) => ({ ...s, picked: { ...s.picked, [path]: !s.picked[path] } }));
}

/** The folders the START button would move. */
export function chosenSources(s: OffloadState): string[] {
  const picked = s.candidates.filter((c) => s.picked[c.path]).map((c) => c.path);
  if (picked.length) return picked;
  return s.sourceInput.trim() ? [s.sourceInput.trim()] : [];
}

const MODE_WORDS: Record<RemoveMode, string> = {
  keep: "The originals stay where they are.",
  trash: "Then each folder is moved to the Trash, if every file in it is verified on the drive.",
  delete: "Then each original is deleted once its copy has been read back from the drive twice.",
};

export function modeWords(mode: RemoveMode): string {
  return MODE_WORDS[mode];
}

/** Check, confirm and run the offload of every chosen folder, one by one. */
export async function startOffload(): Promise<void> {
  const state = store.get();
  const sources = chosenSources(state);
  const dest = state.dest.trim();
  if (!sources.length || !dest || offloadBusy(state)) return;
  patchOffload({ phase: "planning", error: null, reports: [], sources, running: 0, progress: null });
  let files = 0;
  let bytes = 0;
  let label = "";
  let free = 0;
  try {
    // Every folder is checked before the first one is touched.
    for (const source of sources) {
      const plan = await planOffload(source, dest);
      files += plan.files;
      bytes += plan.bytes;
      label = plan.store_label;
      free = plan.free_bytes;
    }
  } catch (err) {
    patchOffload({ phase: "error", error: errorMessage(err) });
    return;
  }
  const what = sources.length === 1 ? sources[0] : `${sources.length} folders`;
  const go = await ask(
    `Copy ${what} (${files.toLocaleString()} files, ${formatBytes(bytes)}) to "${label}" (${formatBytes(free)} free)?\n\n` +
      `Every file is read back from the drive and compared before it counts as copied. ${MODE_WORDS[state.remove]}`,
  );
  if (!go) {
    patchOffload({ phase: "setup" });
    return;
  }

  abort = new AbortController();
  patchOffload({ phase: "running" });
  const reports: OffloadReport[] = [];
  try {
    for (let i = 0; i < sources.length; i++) {
      patchOffload({ running: i, progress: null });
      const report = await runOffload(sources[i], dest, state.remove, (progress) => patchOffload({ progress }), abort.signal);
      reports.push(report);
      patchOffload({ reports: [...reports] });
      // A cancel or a drive problem stops the queue; one folder's unreadable
      // file doesn't.
      if (report.outcome === "cancelled" || report.stopped) break;
    }
    patchOffload({ phase: "done", progress: null });
  } catch (err) {
    patchOffload({ phase: "error", error: errorMessage(err), progress: null });
  }
  abort = null;
  void loadCatalog();
  void loadVolumes();
  void loadTips();
}

export function cancelOffload(): void {
  abort?.abort();
}

export function resetOffload(): void {
  patchOffload({ phase: "setup", reports: [], error: null, progress: null, picked: {} });
}

// ---------------------------------------------------------------------------
// DRIVES and FIND
// ---------------------------------------------------------------------------

export function setQuery(query: string): void {
  patchOffload({ query });
  if (searchTimer) clearTimeout(searchTimer);
  if (!query.trim()) {
    patchOffload({ hits: null, driveHits: null });
    return;
  }
  searchTimer = setTimeout(() => {
    searchOffloaded(query)
      .then((hits) => {
        if (store.get().query === query) patchOffload({ hits });
      })
      .catch((err) => patchOffload({ hits: [], catalogError: errorMessage(err) }));
    searchDrives(query)
      .then((driveHits) => {
        if (store.get().query === query) patchOffload({ driveHits });
      })
      .catch(() => patchOffload({ driveHits: [] }));
  }, 200);
}

export function selectJob(jobId: string | null): void {
  patchOffload({ selectedJob: jobId, jobProblems: null });
}

function removalLines(removal: ReleaseReport["removal"]): string[] {
  const lines: string[] = [];
  if (removal.trashed) lines.push(`${removal.removed_files.toLocaleString()} originals (${formatBytes(removal.removed_bytes)}) moved to the Trash`);
  else if (removal.removed_files) lines.push(`${removal.removed_files.toLocaleString()} originals removed, ${formatBytes(removal.freed_bytes)} freed`);
  if (removal.kept_files) lines.push(`${removal.kept_files.toLocaleString()} originals kept because a check did not pass`);
  if (removal.already_gone) lines.push(`${removal.already_gone.toLocaleString()} were already gone`);
  if (removal.folders_left) lines.push(`${removal.folders_left.toLocaleString()} folders left (not empty)`);
  return lines;
}

export { removalLines };

async function act<R>(job: OffloadJob, kind: "check" | "restore" | "release", start: (onProgress: (p: OffloadProgress) => void, signal: AbortSignal) => Promise<R>, describe: (report: R) => ActionResult): Promise<void> {
  if (offloadBusy(store.get())) return;
  abort = new AbortController();
  patchOffload({ action: { jobId: job.id, kind, progress: null }, result: null });
  try {
    const report = await start((progress) => {
      const action = store.get().action;
      if (action) patchOffload({ action: { ...action, progress } });
    }, abort.signal);
    patchOffload({ action: null, result: describe(report) });
  } catch (err) {
    patchOffload({ action: null, result: { jobId: job.id, headline: errorMessage(err), good: false, lines: [], problems: [], problemsTotal: 0 } });
  }
  abort = null;
  void loadCatalog();
  void loadTips();
}

/** Read every file of a job back from the drive and compare. */
export function checkJob(job: OffloadJob): Promise<void> {
  return act<CheckReport>(
    job,
    "check",
    (onProgress, signal) => checkOffload(job.id, onProgress, signal),
    (r) => ({
      jobId: job.id,
      good: r.outcome === "ok",
      headline:
        r.outcome === "ok"
          ? `All ${r.ok.toLocaleString()} files and folders read back correctly (${formatBytes(r.bytes_read)})`
          : r.outcome === "cancelled"
            ? `Check cancelled after ${r.checked.toLocaleString()} files and folders`
            : `${(r.missing + r.damaged).toLocaleString()} of ${r.checked.toLocaleString()} files and folders have a problem`,
      lines: [r.missing ? `${r.missing.toLocaleString()} missing from the drive` : "", r.damaged ? `${r.damaged.toLocaleString()} damaged on the drive` : ""].filter(Boolean),
      problems: r.problems,
      problemsTotal: r.problems_total,
    }),
  );
}

/** Copy a job (or one path in it) back to where it came from, or to `to`. */
export function restoreJob(job: OffloadJob, only: string | null, to: string | null): Promise<void> {
  return act<RestoreReport>(
    job,
    "restore",
    (onProgress, signal) => restoreOffload(job.id, only, to, onProgress, signal),
    (r) => ({
      jobId: job.id,
      good: r.outcome === "complete",
      headline:
        r.outcome === "complete"
          ? `Restored to ${r.target}`
          : r.outcome === "cancelled"
            ? "Restore cancelled"
            : `Restore incomplete${r.stopped ? `: ${r.stopped}` : ""}`,
      lines: [
        `${r.restored_files.toLocaleString()} files copied back (${formatBytes(r.restored_bytes)})`,
        r.already_files ? `${r.already_files.toLocaleString()} were already there, identical` : "",
        r.failed ? `${r.failed.toLocaleString()} could not be restored` : "",
      ].filter(Boolean),
      problems: r.problems,
      problemsTotal: r.problems_total,
    }),
  );
}

/** Remove the originals of a job whose copies are on the drive. */
export async function releaseJob(job: OffloadJob, mode: "trash" | "delete"): Promise<void> {
  const left = job.verified_files - job.removed_files;
  const go = await ask(
    `${mode === "trash" ? "Move" : "Delete"} the originals of ${job.source_path}${mode === "trash" ? " to the Trash" : ""}?\n\n` +
      `${left.toLocaleString()} files (${formatBytes(job.verified_bytes - job.removed_bytes)}). Each copy is read back from the drive first; ` +
      "an original whose copy is missing or damaged, or that changed since it was copied, is left where it is.",
  );
  if (!go) return;
  return act<ReleaseReport>(
    job,
    "release",
    (onProgress, signal) => releaseOffload(job.id, mode, onProgress, signal),
    (r) => ({
      jobId: job.id,
      good: r.outcome === "complete",
      headline: r.outcome === "complete" ? "Originals removed" : r.outcome === "cancelled" ? "Cancelled" : `Not everything was removed${r.stopped ? `: ${r.stopped}` : ""}`,
      lines: removalLines(r.removal),
      problems: r.problems,
      problemsTotal: r.problems_total,
    }),
  );
}

export function cancelAction(): void {
  abort?.abort();
}

export async function showProblems(jobId: string): Promise<void> {
  if (store.get().jobProblems?.jobId === jobId) {
    patchOffload({ jobProblems: null });
    return;
  }
  try {
    patchOffload({ jobProblems: { jobId, rows: await getOffloadProblems(jobId) } });
  } catch (err) {
    void notify(errorMessage(err));
  }
}

export async function forgetJob(job: OffloadJob): Promise<void> {
  const gone = job.removed_files > 0;
  const go = await ask(
    `Forget the record of ${job.source_path}?\n\n` +
      "Nothing is deleted from the drive or the computer. " +
      (gone
        ? `But ${job.removed_files.toLocaleString()} of these files now exist only on the drive, and the app will no longer know where. (IMPORT can read the record back from the drive.)`
        : "Only the app's record of this offload goes."),
  );
  if (!go) return;
  try {
    await forgetOffload(job.id);
    patchOffload({ selectedJob: null, result: null });
    await loadCatalog();
  } catch (err) {
    void notify(errorMessage(err));
  }
}

export async function importStore(path: string): Promise<void> {
  try {
    const r = await importOffloadStore(path);
    await loadCatalog();
    void notify(
      `"${r.store_label}": ${r.jobs_added} offload(s) added with ${r.files_added.toLocaleString()} files` +
        (r.jobs_known ? `, ${r.jobs_known} already known` : "") +
        (r.rows_rejected ? `, ${r.rows_rejected} invalid entries ignored` : "") +
        ".",
    );
  } catch (err) {
    void notify(errorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// CATALOG: everything on a drive, offloaded or not, browsable and scannable
// ---------------------------------------------------------------------------

/** Catalog the drive (or folder on a drive) at `path`, then show it. */
export async function runCatalog(path: string): Promise<void> {
  if (offloadBusy(store.get())) return;
  abort = new AbortController();
  patchOffload({ section: "catalog", cataloging: { path, progress: null }, catalogNote: null });
  try {
    const r = await catalogDrive(
      path,
      (progress) => {
        const cataloging = store.get().cataloging;
        if (cataloging) patchOffload({ cataloging: { ...cataloging, progress } });
      },
      abort.signal,
    );
    if (r.outcome === "cancelled") {
      patchOffload({ cataloging: null, catalogNote: { good: false, text: `Cataloging "${r.store_label}" was cancelled. Its previous catalog, if it had one, is unchanged.` } });
    } else {
      patchOffload({
        cataloging: null,
        catalogNote: {
          good: !r.unreadable,
          text:
            `"${r.store_label}": ${r.files.toLocaleString()} files in ${r.dirs.toLocaleString()} folders, ${formatBytes(r.bytes)}` +
            (r.unreadable ? `. ${r.unreadable.toLocaleString()} folders couldn't be read and are listed empty.` : "."),
        },
      });
      void browseDrive(r.store_id, "");
    }
  } catch (err) {
    patchOffload({ cataloging: null, catalogNote: { good: false, text: errorMessage(err) } });
  }
  abort = null;
  void loadCatalog();
}

export function cancelCatalog(): void {
  abort?.abort();
}

/** Show one folder of a drive's catalog ("" is the top). */
export async function browseDrive(storeId: string, rel: string): Promise<void> {
  const keep = store.get().browse;
  const listing = keep?.storeId === storeId ? keep.listing : null;
  patchOffload({ section: "catalog", browse: { storeId, rel, listing, loading: true, error: null } });
  try {
    const next = await listDrive(storeId, rel);
    const now = store.get().browse;
    if (now?.storeId === storeId && now.rel === rel) patchOffload({ browse: { ...now, listing: next, loading: false } });
  } catch (err) {
    const now = store.get().browse;
    if (now?.storeId === storeId && now.rel === rel) patchOffload({ browse: { ...now, loading: false, error: errorMessage(err) } });
  }
}

export function closeBrowse(): void {
  patchOffload({ browse: null });
}

/** Open the CATALOG section on a drive: its catalog if it has one. */
export function openDriveCatalog(storeId: string): void {
  openOffload();
  void browseDrive(storeId, "");
}

/** Scan a folder of a cataloged drive in the scan window. */
export function scanCatalogPath(path: string): void {
  void scanFolder(path);
}

export async function forgetCatalog(storeId: string, label: string): Promise<void> {
  const go = await ask(`Forget the catalog of "${label}"?\n\nNothing on the drive is touched; it can be cataloged again whenever it is plugged in.`);
  if (!go) return;
  try {
    await forgetDriveCatalog(storeId);
    if (store.get().browse?.storeId === storeId) patchOffload({ browse: null });
    await loadCatalog();
  } catch (err) {
    void notify(errorMessage(err));
  }
}
