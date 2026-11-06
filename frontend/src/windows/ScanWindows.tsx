/**
 * Scanning in one window: the folder bar on top, then the result's findings
 * and file types, and the library of saved scans and comparisons, as sections
 * of which one is open at a time.
 */
import { useMemo } from "react";
import { formatBytes } from "../api";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ExtensionSummary } from "../components/ExtensionSummary";
import { FiltersBar } from "../components/FiltersBar";
import { FindingsTable } from "../components/FindingsTable";
import { useApp, useLibrarySummary } from "../state/app";
import {
  cancelScan,
  closeScan,
  patchScan,
  refreshScan,
  resetScan,
  saveScan,
  SCAN,
  startScan,
  useScan,
  type ScanSection,
} from "../state/scan";
import { Window } from "../wm/Window";
import { baseName, formatDate } from "./common";
import type { WindowArgs } from "./HubWindows";
import { Library } from "./Library";
import { pickDirectory } from "./pickDirectory";
import { Section } from "./Section";

export function ScanWindow({ view, controls }: WindowArgs) {
  const s = useScan(SCAN);
  const ready = useApp((a) => a.connected === true);
  const librarySummary = useLibrarySummary();
  const findings = s?.findings;
  const category = s?.category ?? "all";
  const query = s?.query ?? "";
  const categories = useMemo(() => Array.from(new Set((findings ?? []).map((f) => f.category))).sort(), [findings]);
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return (findings ?? []).filter(
      (f) =>
        (category === "all" || f.category === category) &&
        (!q || f.reason.toLowerCase().includes(q) || f.paths.some((p) => p.toLowerCase().includes(q))),
    );
  }, [findings, category, query]);
  if (!s) return null;

  const root = s.info?.rootPath || s.path;
  const scanning = s.phase === "scanning";
  const results = s.phase === "results" && !!s.info;
  const title = s.snapshotId ? `SCAN · ${baseName(root)} (saved)` : results ? `SCAN · ${baseName(root)}` : "SCAN";
  const shadeInfo = scanning
    ? `scanning ${s.progress?.progress_percent ?? 0}%`
    : s.info
      ? formatBytes(s.info.totalSizeBytes)
      : undefined;
  const section = (id: ScanSection) => ({
    open: s.section === id,
    onToggle: () => patchScan(SCAN, { section: s.section === id ? (id === "library" ? "findings" : "library") : id }),
  });

  return (
    <Window title={title} shadeInfo={shadeInfo} view={view} controls={controls} className="kind-scan" onClose={() => void closeScan()}>
      <div className="tool">
        <div className="field-row">
          <span className={`led ${scanning ? "is-busy" : s.phase === "error" ? "is-bad" : ""}`} data-on={ready} />
          <input
            className="lcd-input"
            value={s.path}
            placeholder="/path/to/folder"
            onChange={(e) => patchScan(SCAN, { path: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && ready && !scanning && void startScan(SCAN)}
            spellCheck={false}
            aria-label="Folder to scan"
            disabled={scanning}
          />
          <button
            type="button"
            className="steel-btn"
            disabled={scanning}
            onClick={async () => {
              const picked = await pickDirectory();
              if (picked) patchScan(SCAN, { path: picked });
            }}
          >
            BROWSE
          </button>
          {scanning ? (
            <button type="button" className="steel-btn is-warn" onClick={() => cancelScan(SCAN)}>
              CANCEL
            </button>
          ) : (
            <button type="button" className="steel-btn is-primary" onClick={() => void startScan(SCAN)} disabled={!ready || !s.path.trim()}>
              SCAN
            </button>
          )}
        </div>

        {scanning ? (
          <>
            <div className="seekbar" role="progressbar" aria-valuenow={s.progress?.progress_percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${s.progress?.progress_percent ?? 0}%` }} />
            </div>
            <div className="lcd stats">
              <span>{(s.progress?.files_scanned ?? 0).toLocaleString()} files</span>
              <span>{formatBytes(s.progress?.bytes_scanned ?? 0)}</span>
              <span>{(s.progress?.elapsed_seconds ?? 0).toFixed(0)}s</span>
              <span className="lcd-dim lcd-ellipsis">{s.progress?.current_path}</span>
            </div>
          </>
        ) : results && s.info ? (
          <div className="lcd scan-summary">
            <span className="scan-total">{formatBytes(s.info.totalSizeBytes)}</span>
            <span className="lcd-ellipsis lcd-strong" title={s.info.rootPath}>
              {s.info.rootPath}
            </span>
            <span className="lcd-dim">
              {s.info.totalFiles.toLocaleString()} files · {s.info.totalFolders.toLocaleString()} folders
            </span>
            <span className="spacer" />
            {s.busy === "refreshing" ? (
              <span className="lcd-accent blink">REFRESHING</span>
            ) : s.problem ? (
              <span className="lcd-bad lcd-ellipsis" title={s.problem}>
                ⚠ {s.problem}
              </span>
            ) : s.savedAt ? (
              <span className="lcd-dim" title={`saved ${formatDate(s.savedAt)}`}>
                saved
              </span>
            ) : null}
            {s.snapshotId ? (
              <button type="button" className="chip" onClick={() => void refreshScan(SCAN)} disabled={!!s.busy || !ready}>
                UPDATE
              </button>
            ) : (
              <button type="button" className="chip is-cmd" onClick={() => void saveScan(SCAN)} disabled={!!s.busy || !s.scanId}>
                {s.busy === "saving" ? "SAVING…" : "SAVE"}
              </button>
            )}
            <button type="button" className="chip" onClick={() => void resetScan()} title="Clear these results">
              NEW
            </button>
          </div>
        ) : (
          <div className="lcd lcd-banner">
            {s.phase === "error" ? (
              <span className="lcd-bad lcd-ellipsis">FAILED · {s.error}</span>
            ) : (
              <span className="lcd-dim">{ready ? "Pick a folder and press SCAN. Read-only: nothing is deleted." : "Waiting for the backend…"}</span>
            )}
          </div>
        )}

        {results ? (
          <>
            <Section title="FINDINGS" info={s.loadingResults ? "…" : s.findings.length} fill {...section("findings")}>
              <div className="lcd table-panel">
                <ErrorBoundary>
                  <FiltersBar
                    categories={categories}
                    selectedCategory={category}
                    setSelectedCategory={(c) => patchScan(SCAN, { category: c })}
                    searchQuery={query}
                    setSearchQuery={(q) => patchScan(SCAN, { query: q })}
                  />
                  {s.loadingResults ? <div className="lcd-dim pad">Loading findings…</div> : <FindingsTable findings={filtered} />}
                </ErrorBoundary>
              </div>
            </Section>
            <Section title="FILE TYPES" info={s.loadingResults ? "…" : s.extensions.length} fill {...section("types")}>
              <div className="lcd table-panel">
                <ErrorBoundary>
                  {s.loadingResults ? <div className="lcd-dim pad">Loading…</div> : <ExtensionSummary extensions={s.extensions} />}
                </ErrorBoundary>
              </div>
            </Section>
          </>
        ) : null}
        <Section title="LIBRARY" info={librarySummary} fill {...section("library")}>
          <Library />
        </Section>
      </div>
    </Window>
  );
}
