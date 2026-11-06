/**
 * The library: every saved scan and comparison, playlist style. Opening a
 * scan shows it in the scan window; a comparison opens in the compare window.
 */
import { formatBytes, type ComparisonSnapshot } from "../api";
import { ask, notify } from "../desktop";
import { loadSnapshots, removeSnapshot, useApp } from "../state/app";
import { forgetCompareSnapshot, openCompareSnapshot, useOpenCompareSnapshot } from "../state/compare";
import { forgetScanSnapshot, openScanSnapshot, useOpenScanSnapshot } from "../state/scan";
import { baseName, errorMessage, formatDate } from "./common";

function open(snapshot: ComparisonSnapshot): void {
  if (snapshot.snapshotType === "comparison") void openCompareSnapshot(snapshot);
  else void openScanSnapshot(snapshot);
}

async function remove(snapshot: ComparisonSnapshot): Promise<void> {
  try {
    await removeSnapshot(snapshot.id);
    forgetScanSnapshot(snapshot.id);
    forgetCompareSnapshot(snapshot.id);
  } catch (err) {
    await notify(`Failed to delete snapshot: ${errorMessage(err)}`);
  }
}

export function Library() {
  const snapshots = useApp((s) => s.snapshots);
  const loading = useApp((s) => s.snapshotsLoading && !s.snapshotsError);
  const error = useApp((s) => s.snapshotsError);
  const problems = useApp((s) => s.problems);
  const openIds = new Set([useOpenScanSnapshot(), useOpenCompareSnapshot()].filter(Boolean));
  const list = snapshots.filter((s) => s && s.id);

  return (
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
        <div className="lcd-dim pad">Nothing saved yet. Scan or compare, then press SAVE to keep it here.</div>
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
                  onClick={async () => {
                    if (await ask(`Delete this ${comparison ? "comparison" : "snapshot"}?\n\n${where}`)) void remove(s);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        : null}
    </div>
  );
}
