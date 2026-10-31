/**
 * A scan as three windows: a small control window (folder, progress, save),
 * the findings, and the file types. A saved snapshot opens the same way.
 */
import { useMemo } from "react";
import { formatBytes } from "../api";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ExtensionSummary } from "../components/ExtensionSummary";
import { FiltersBar } from "../components/FiltersBar";
import { FindingsTable } from "../components/FindingsTable";
import { useApp } from "../state/app";
import {
  cancelScan,
  closeScan,
  findingsId,
  patchScan,
  refreshScan,
  saveScan,
  startScan,
  typesId,
  useScan,
} from "../state/scan";
import { useStore } from "../store";
import { closeWindow, openWindow, wmStore } from "../wm/state";
import { Window } from "../wm/Window";
import { baseName, formatDate } from "./common";
import type { WindowArgs } from "./HubWindows";
import { pickDirectory } from "./pickDirectory";

export function ScanWindow({ view, controls }: WindowArgs) {
  const id = view.unit.id;
  const s = useScan(view.unit.ref);
  const ready = useApp((a) => a.connected === true);
  const open = useStore(wmStore, (w) => w.units.map((u) => u.id).join(" "));
  if (!s) return null;

  const root = s.info?.rootPath || s.path;
  const title = s.snapshotId ? `SNAPSHOT · ${baseName(root)}` : s.phase === "setup" ? "NEW SCAN" : `SCAN · ${baseName(root)}`;
  const shadeInfo =
    s.phase === "scanning" ? `scanning ${s.progress?.progress_percent ?? 0}%` : s.info ? formatBytes(s.info.totalSizeBytes) : undefined;
  const toggle = (windowId: string, kind: "findings" | "types") =>
    open.split(" ").includes(windowId) ? closeWindow(windowId) : openWindow(kind, windowId, { ref: id, parent: id });

  return (
    <Window title={title} shadeInfo={shadeInfo} view={view} controls={controls} className="kind-scan" onClose={() => closeScan(id)}>
      <div className="tool">
        {s.phase === "setup" || s.phase === "error" ? (
          <>
            <div className="lcd lcd-banner">
              <span className={`led ${s.phase === "error" ? "is-bad" : ""}`} data-on={ready} />
              {s.phase === "error" ? (
                <span className="lcd-bad">FAILED · {s.error}</span>
              ) : (
                <span>{ready ? "CHOOSE A FOLDER" : "WAITING FOR BACKEND"}</span>
              )}
            </div>
            <div className="field-row">
              <input
                className="lcd-input"
                value={s.path}
                placeholder="/path/to/folder"
                onChange={(e) => patchScan(id, { path: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && ready && void startScan(id)}
                spellCheck={false}
                aria-label="Folder to scan"
              />
              <button
                type="button"
                className="steel-btn"
                onClick={async () => {
                  const picked = await pickDirectory();
                  if (picked) patchScan(id, { path: picked });
                }}
              >
                BROWSE
              </button>
            </div>
            <div className="field-row is-end">
              <span className="hint">Read-only: nothing is deleted.</span>
              <span className="spacer" />
              <button type="button" className="steel-btn is-primary" onClick={() => void startScan(id)} disabled={!ready || !s.path.trim()}>
                SCAN
              </button>
            </div>
          </>
        ) : null}

        {s.phase === "scanning" ? (
          <>
            <div className="lcd lcd-banner">
              <span className="led is-busy" data-on />
              <span>SCANNING {baseName(root)}</span>
            </div>
            <div className="seekbar" role="progressbar" aria-valuenow={s.progress?.progress_percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${s.progress?.progress_percent ?? 0}%` }} />
            </div>
            <div className="lcd stats">
              <span>{(s.progress?.files_scanned ?? 0).toLocaleString()} files</span>
              <span>{formatBytes(s.progress?.bytes_scanned ?? 0)}</span>
              <span>{(s.progress?.elapsed_seconds ?? 0).toFixed(0)}s</span>
            </div>
            <div className="lcd lcd-ellipsis lcd-dim">{s.log[s.log.length - 1]}</div>
            <div className="field-row is-end">
              <button type="button" className="steel-btn is-warn" onClick={() => cancelScan(id)}>
                CANCEL
              </button>
            </div>
          </>
        ) : null}

        {s.phase === "results" && s.info ? (
          <>
            <div className="lcd readout">
              <div className="lcd-ellipsis lcd-strong" title={s.info.rootPath}>
                {s.info.rootPath}
              </div>
              <div className="readout-big">{formatBytes(s.info.totalSizeBytes)}</div>
              <div className="stats">
                <span>{s.info.totalFiles.toLocaleString()} files</span>
                <span>{s.info.totalFolders.toLocaleString()} folders</span>
              </div>
              {s.busy === "refreshing" ? (
                <div className="lcd-accent blink">REFRESHING</div>
              ) : s.problem ? (
                <div className="lcd-bad lcd-ellipsis" title={s.problem}>
                  ⚠ {s.problem}
                </div>
              ) : s.savedAt ? (
                <div className="lcd-dim">saved {formatDate(s.savedAt)}</div>
              ) : (
                <div className="lcd-dim">not saved</div>
              )}
            </div>
            <div className="field-row">
              <button
                type="button"
                className={`steel-btn is-toggle ${open.split(" ").includes(findingsId(id)) ? "is-on" : ""}`}
                onClick={() => toggle(findingsId(id), "findings")}
              >
                <span className="btn-led" />
                FINDINGS
              </button>
              <button
                type="button"
                className={`steel-btn is-toggle ${open.split(" ").includes(typesId(id)) ? "is-on" : ""}`}
                onClick={() => toggle(typesId(id), "types")}
              >
                <span className="btn-led" />
                TYPES
              </button>
              <span className="spacer" />
              {s.snapshotId ? (
                <button type="button" className="steel-btn" onClick={() => void refreshScan(id)} disabled={!!s.busy || !ready}>
                  UPDATE
                </button>
              ) : (
                <button type="button" className="steel-btn is-primary" onClick={() => void saveScan(id)} disabled={!!s.busy || !s.scanId}>
                  {s.busy === "saving" ? "SAVING…" : "SAVE"}
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Window>
  );
}

export function FindingsWindow({ view, controls }: WindowArgs) {
  const s = useScan(view.unit.ref);
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

  return (
    <Window
      title={`FINDINGS · ${baseName(s.info?.rootPath || s.path)}`}
      shadeInfo={`${s.findings.length} findings`}
      view={view}
      controls={controls}
      className="kind-findings"
    >
      <div className="lcd table-panel">
        <ErrorBoundary>
          <FiltersBar
            categories={categories}
            selectedCategory={category}
            setSelectedCategory={(c) => patchScan(s.id, { category: c })}
            searchQuery={query}
            setSearchQuery={(q) => patchScan(s.id, { query: q })}
          />
          {s.loadingResults ? <div className="lcd-dim pad">Loading findings…</div> : <FindingsTable findings={filtered} />}
        </ErrorBoundary>
      </div>
    </Window>
  );
}

export function TypesWindow({ view, controls }: WindowArgs) {
  const s = useScan(view.unit.ref);
  if (!s) return null;
  return (
    <Window
      title={`TYPES · ${baseName(s.info?.rootPath || s.path)}`}
      shadeInfo={`${s.extensions.length} types`}
      view={view}
      controls={controls}
      className="kind-types"
    >
      <div className="lcd table-panel">
        <ErrorBoundary>
          {s.loadingResults ? <div className="lcd-dim pad">Loading…</div> : <ExtensionSummary extensions={s.extensions} />}
        </ErrorBoundary>
      </div>
    </Window>
  );
}
