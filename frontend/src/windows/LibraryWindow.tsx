/**
 * The library: every saved snapshot and comparison, playlist style. Opening
 * one gives it a window of its own (or flashes the one it already has).
 */
import { formatBytes, type ComparisonSnapshot } from "../api";
import { Window } from "../wm/Window";
import type { UnitControls, UnitView } from "../wm/Cluster";
import { baseName, formatDate } from "./common";

interface LibraryWindowProps {
  view: UnitView;
  controls: UnitControls;
  snapshots: ComparisonSnapshot[];
  loading: boolean;
  error: string | null;
  problems: Record<string, string>;
  openIds: Set<string>;
  onOpen: (snapshot: ComparisonSnapshot) => void;
  onDelete: (snapshot: ComparisonSnapshot) => void;
  onRetry: () => void;
}

export function LibraryWindow({
  view,
  controls,
  snapshots,
  loading,
  error,
  problems,
  openIds,
  onOpen,
  onDelete,
  onRetry,
}: LibraryWindowProps) {
  const list = snapshots.filter((s) => s && s.id);
  const total = list.reduce((sum, s) => sum + (s.snapshotType === "comparison" ? 0 : s.totalSizeBytes || 0), 0);

  return (
    <Window
      title="LIBRARY"
      shadeInfo={`${list.length} saved`}
      view={view}
      controls={controls}
      className="kind-library"
    >
      <div className="library">
        <div className="lcd library-list" role="list">
          {loading ? <div className="lcd-dim pad blink">LOADING SNAPSHOTS…</div> : null}
          {!loading && error ? (
            <div className="pad">
              <div className="lcd-bad">Couldn't load snapshots: {error}</div>
              <button type="button" className="chip" onClick={onRetry}>
                RETRY
              </button>
            </div>
          ) : null}
          {!loading && !error && list.length === 0 ? (
            <div className="lcd-dim pad">
              Nothing saved yet. Run a scan or comparison and press SAVE to keep it here.
            </div>
          ) : null}
          {!loading && !error
            ? list.map((s, i) => {
                const comparison = s.snapshotType === "comparison";
                const problem = problems[s.id];
                const label = comparison ? `${baseName(s.rootPath)} ⇄ ${baseName(s.targetPath || "")}` : baseName(s.rootPath);
                const where = comparison ? `${s.rootPath} ⇄ ${s.targetPath}` : s.rootPath;
                return (
                  <div
                    key={s.id}
                    role="listitem"
                    className={`library-row ${openIds.has(s.id) ? "is-open" : ""} ${problem ? "is-problem" : ""}`}
                    title={`${where}\nsaved ${formatDate(s.savedAt)}${problem ? `\n⚠ ${problem}` : ""}`}
                  >
                    <button type="button" className="library-open" onClick={() => onOpen(s)}>
                      <span className="library-num">{String(i + 1).padStart(2, "0")}.</span>
                      <span className="library-kind">{comparison ? "⇄" : "▣"}</span>
                      <span className="library-name">{label}</span>
                      {problem ? <span className="lcd-bad">⚠</span> : null}
                      <span className="library-size">{comparison ? "CMP" : formatBytes(s.totalSizeBytes || 0)}</span>
                    </button>
                    <button
                      type="button"
                      className="library-del"
                      aria-label={`Delete ${label}`}
                      title="Delete"
                      onClick={() => {
                        if (window.confirm(`Delete this ${comparison ? "comparison" : "snapshot"}?\n\n${where}`)) onDelete(s);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })
            : null}
        </div>
        <div className="library-foot">
          <span>{list.length} ITEM{list.length === 1 ? "" : "S"}</span>
          <span className="spacer" />
          <span>{formatBytes(total)}</span>
        </div>
      </div>
    </Window>
  );
}
