/**
 * One scan per window: pick a folder, watch it scan, read the findings.
 * Opened from the library, the same window shows a saved snapshot and
 * quietly re-scans it in the background so the numbers are current.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatBytes,
  getExtensionSummary,
  getFindings,
  saveSnapshot,
  scanWithProgress,
  updateSnapshot,
  type ComparisonSnapshot,
  type ExtensionSummary as ExtSummary,
  type Finding,
  type ProgressEventData,
  type ScanResponse,
} from "../api";
import { ExtensionSummary } from "../components/ExtensionSummary";
import { FiltersBar } from "../components/FiltersBar";
import { FindingsTable } from "../components/FindingsTable";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Window } from "../wm/Window";
import type { UnitControls, UnitView } from "../wm/Cluster";
import { baseName, errorMessage, formatDate, snapshotProblem } from "./common";
import { pickDirectory } from "./pickDirectory";

type Phase = "setup" | "scanning" | "results" | "error";
type Tab = "findings" | "types";

interface ScanWindowProps {
  view: UnitView;
  controls: UnitControls;
  /** The saved snapshot this window shows, if any. */
  snapshot: ComparisonSnapshot | null;
  connected: boolean;
  onSaved: (snapshot: ComparisonSnapshot) => void;
  onUpdated: (snapshot: ComparisonSnapshot) => void;
  onProblem: (snapshotId: string, problem: string | null) => void;
}

const asScanSnapshot = (s: Omit<ComparisonSnapshot, "snapshotType">): ComparisonSnapshot => ({
  ...s,
  snapshotType: "scan",
});

export function ScanWindow({ view, controls, snapshot, connected, onSaved, onUpdated, onProblem }: ScanWindowProps) {
  const [phase, setPhase] = useState<Phase>(snapshot ? "results" : "setup");
  const [path, setPath] = useState(snapshot?.rootPath ?? "");
  const [progress, setProgress] = useState<ProgressEventData | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ScanResponse | null>(snapshot?.scanInfo ?? null);
  const [findings, setFindings] = useState<Finding[]>(snapshot?.findings ?? []);
  const [extensions, setExtensions] = useState<ExtSummary[]>(snapshot?.extensions ?? []);
  const [scanId, setScanId] = useState<string | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [tab, setTab] = useState<Tab>("findings");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"saving" | "refreshing" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const refreshedRef = useRef(false);

  const snapshotId = snapshot?.id ?? null;

  useEffect(() => () => abortRef.current?.abort(), []);

  const refresh = async (id: string) => {
    setBusy("refreshing");
    try {
      const updated = asScanSnapshot(await updateSnapshot(id));
      setFindings(updated.findings);
      setExtensions(updated.extensions);
      setInfo(updated.scanInfo);
      setProblem(null);
      onProblem(id, null);
      onUpdated(updated);
    } catch (err) {
      console.error("[Snapshot] refresh failed:", err);
      const friendly = snapshotProblem(err);
      setProblem(friendly ?? `Couldn't refresh: ${errorMessage(err)}`);
      if (friendly) onProblem(id, friendly);
    } finally {
      setBusy(null);
    }
  };

  // A snapshot opens with its saved numbers, then re-scans once to update them.
  useEffect(() => {
    if (!snapshotId || !connected || refreshedRef.current) return;
    refreshedRef.current = true;
    void refresh(snapshotId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per window
  }, [snapshotId, connected]);

  const startScan = async () => {
    const root = path.trim();
    if (!root) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("scanning");
    setError(null);
    setProgress(null);
    setLog([`Starting scan of ${root}`]);
    try {
      const result = await scanWithProgress(
        root,
        (event) => {
          setProgress(event);
          setLog((prev) => [...prev.slice(-199), `[${event.progress_percent}%] ${event.message}`]);
        },
        controller.signal,
      );
      abortRef.current = null;
      setInfo(result);
      setScanId(result.scanId);
      setPhase("results");
      setLoadingResults(true);
      const [found, types] = await Promise.all([getFindings(result.scanId), getExtensionSummary(result.scanId)]);
      setFindings(found);
      setExtensions(types);
    } catch (err) {
      abortRef.current = null;
      if (controller.signal.aborted) {
        setPhase("setup");
        return;
      }
      setError(errorMessage(err));
      setPhase("error");
    } finally {
      setLoadingResults(false);
    }
  };

  const browse = async () => {
    const picked = await pickDirectory();
    if (picked) setPath(picked);
  };

  const save = async () => {
    if (!scanId || !info) return;
    setBusy("saving");
    try {
      const saved = asScanSnapshot(await saveSnapshot(scanId, info.rootPath));
      // Just scanned: no need for the re-scan a snapshot window does on open.
      refreshedRef.current = true;
      onSaved(saved);
    } catch (err) {
      console.error("Failed to save snapshot:", err);
      window.alert(`Couldn't save the snapshot: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (phase === "results" && !snapshotId && scanId) {
      if (!window.confirm("This scan isn't saved as a snapshot. Close it anyway?")) return;
    }
    controls.close();
  };

  const categories = useMemo(() => Array.from(new Set(findings.map((f) => f.category))).sort(), [findings]);
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return findings.filter(
      (f) =>
        (category === "all" || f.category === category) &&
        (!q || f.reason.toLowerCase().includes(q) || f.paths.some((p) => p.toLowerCase().includes(q))),
    );
  }, [findings, category, query]);

  const root = info?.rootPath || path;
  const title = snapshotId
    ? `SNAPSHOT · ${baseName(root)}`
    : root && phase !== "setup"
      ? `SCAN · ${baseName(root)}`
      : "NEW SCAN";
  const shadeInfo =
    phase === "scanning"
      ? `scanning ${progress?.progress_percent ?? 0}%`
      : info
        ? formatBytes(info.totalSizeBytes)
        : undefined;

  return (
    <Window title={title} shadeInfo={shadeInfo} view={view} controls={controls} className="kind-scan" onClose={close}>
      <div className="scan-win">
        {phase === "setup" || phase === "error" ? (
          <div className="scan-setup">
            <div className="lcd lcd-banner">
              <span className="led" data-on={connected} />
              {phase === "error" ? (
                <span className="lcd-bad">SCAN FAILED · {error}</span>
              ) : (
                <span>{connected ? "READY · choose a folder to analyse" : "WAITING FOR BACKEND"}</span>
              )}
            </div>
            <div className="field-row">
              <input
                className="lcd-input"
                value={path}
                placeholder="/path/to/folder"
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connected && void startScan()}
                spellCheck={false}
                aria-label="Folder to scan"
              />
              <button type="button" className="steel-btn" onClick={browse}>
                BROWSE
              </button>
              <button type="button" className="steel-btn is-primary" onClick={startScan} disabled={!connected || !path.trim()}>
                SCAN
              </button>
            </div>
            <p className="hint">
              Finds large and old files, duplicates, caches and temp junk. Read-only: nothing is deleted.
            </p>
          </div>
        ) : null}

        {phase === "scanning" ? (
          <div className="scan-progress">
            <div className="lcd lcd-banner">
              <span className="led is-busy" data-on />
              <span className="lcd-ellipsis">SCANNING {root}</span>
            </div>
            <div className="seekbar" role="progressbar" aria-valuenow={progress?.progress_percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${progress?.progress_percent ?? 0}%` }} />
            </div>
            <div className="lcd scan-stats">
              <span>{(progress?.files_scanned ?? 0).toLocaleString()} files</span>
              <span>{(progress?.folders_scanned ?? 0).toLocaleString()} folders</span>
              <span>{formatBytes(progress?.bytes_scanned ?? 0)}</span>
              <span>{(progress?.elapsed_seconds ?? 0).toFixed(0)}s</span>
            </div>
            <div className="lcd scan-log">
              {log.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
            <div className="field-row is-end">
              <button type="button" className="steel-btn is-warn" onClick={() => abortRef.current?.abort()}>
                CANCEL
              </button>
            </div>
          </div>
        ) : null}

        {phase === "results" && info ? (
          <div className="scan-results">
            <div className="lcd scan-stats">
              <span className="lcd-ellipsis lcd-strong" title={info.rootPath}>
                {info.rootPath}
              </span>
              <span>{info.totalFiles.toLocaleString()} files</span>
              <span>{info.totalFolders.toLocaleString()} folders</span>
              <span className="lcd-strong">{formatBytes(info.totalSizeBytes)}</span>
              {snapshot ? <span className="lcd-dim">saved {formatDate(snapshot.savedAt)}</span> : null}
              {busy === "refreshing" ? <span className="lcd-accent blink">REFRESHING</span> : null}
            </div>
            {problem ? <div className="lcd lcd-bad scan-problem">⚠ {problem} · showing saved data</div> : null}
            <div className="lcd-toolbar">
              <div className="seg">
                <button type="button" className={`seg-btn ${tab === "findings" ? "is-on" : ""}`} onClick={() => setTab("findings")}>
                  FINDINGS {findings.length}
                </button>
                <button type="button" className={`seg-btn ${tab === "types" ? "is-on" : ""}`} onClick={() => setTab("types")}>
                  TYPES {extensions.length}
                </button>
              </div>
              <span className="spacer" />
              {snapshotId ? (
                <button type="button" className="steel-btn" onClick={() => void refresh(snapshotId)} disabled={!!busy || !connected}>
                  UPDATE SNAPSHOT
                </button>
              ) : (
                <button type="button" className="steel-btn is-primary" onClick={save} disabled={!!busy || !scanId}>
                  {busy === "saving" ? "SAVING…" : "SAVE SNAPSHOT"}
                </button>
              )}
            </div>
            <div className="scan-results-body">
              <ErrorBoundary>
                {tab === "findings" ? (
                  <>
                    <FiltersBar
                      categories={categories}
                      selectedCategory={category}
                      setSelectedCategory={setCategory}
                      searchQuery={query}
                      setSearchQuery={setQuery}
                    />
                    {loadingResults ? <div className="lcd-dim pad">Loading findings…</div> : <FindingsTable findings={filtered} />}
                  </>
                ) : (
                  <ExtensionSummary extensions={extensions} />
                )}
              </ErrorBoundary>
            </div>
          </div>
        ) : null}
      </div>
    </Window>
  );
}
