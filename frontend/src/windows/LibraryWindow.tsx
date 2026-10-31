/**
 * The library: every saved snapshot and comparison, playlist style. Opening
 * one gives it windows of its own (or flashes the ones it already has).
 */
import { formatBytes, type ComparisonSnapshot } from "../api";
import { loadSnapshots, removeSnapshot, useApp } from "../state/app";
import { forgetCompareSnapshot, openCompareSnapshot, useOpenCompareSnapshots } from "../state/compare";
import { forgetScanSnapshot, openScanSnapshot, useOpenScanSnapshots } from "../state/scan";
import { Window } from "../wm/Window";
import { baseName, errorMessage, formatDate } from "./common";
import type { WindowArgs } from "./HubWindows";

function open(snapshot: ComparisonSnapshot): void {
  if (snapshot.snapshotType === "comparison") openCompareSnapshot(snapshot);
  else openScanSnapshot(snapshot);
}

async function remove(snapshot: ComparisonSnapshot): Promise<void> {
  try {
    await removeSnapshot(snapshot.id);
    // A window showing a deleted snapshot has nothing left to show.
    forgetScanSnapshot(snapshot.id);
    forgetCompareSnapshot(snapshot.id);
  } catch (err) {
    window.alert(`Failed to delete snapshot: ${errorMessage(err)}`);
  }
}

export function LibraryWindow({ view, controls }: WindowArgs) {
  const snapshots = useApp((s) => s.snapshots);
  const loading = useApp((s) => s.snapshotsLoading && !s.snapshotsError);
  const error = useApp((s) => s.snapshotsError);
  const problems = useApp((s) => s.problems);
  const openIds = new Set([...useOpenScanSnapshots().split(" "), ...useOpenCompareSnapshots().split(" ")]);

  const list = snapshots.filter((s) => s && s.id);
  const total = list.reduce((sum, s) => sum + (s.snapshotType === "comparison" ? 0 : s.totalSizeBytes || 0), 0);

  return (
    <Window title="LIBRARY" shadeInfo={`${list.length} saved`} view={view} controls={controls} className="kind-library">
      <div className="library">
        <div className="lcd library-list" role="list">
          {loading ? <div className="lcd-dim pad blink">LOADING SNAPSHOTS…</div> : null}
          {!loading && error ? (
            <div className="pad">
              <div className="lcd-bad">Couldn't load snapshots: {error}</div>
              <button type="button" className="chip" onClick={() => void loadSnapshots()}>
                RETRY
              </button>
            </div>
          ) : null}
          {!loading && !error && list.length === 0 ? (
            <div className="lcd-dim pad">Nothing saved yet. Run a scan or comparison and press SAVE to keep it here.</div>
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
                    <button type="button" className="library-open" onClick={() => open(s)}>
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
                        if (window.confirm(`Delete this ${comparison ? "comparison" : "snapshot"}?\n\n${where}`)) void remove(s);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })
            : null}
        </div>
        <div className="win-foot">
          <span>
            {list.length} ITEM{list.length === 1 ? "" : "S"}
          </span>
          <span className="spacer" />
          <span>{formatBytes(total)}</span>
        </div>
      </div>
    </Window>
  );
}
