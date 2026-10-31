/**
 * A comparison as a pair of windows docked side by side: the source folder on
 * the left, the target on the right, row for row like a diff. The two share
 * one filter, one set of open folders and one scroll position, and they dock,
 * drag and close as a unit.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  compareDirectories,
  formatBytes,
  saveComparisonSnapshot,
  updateComparisonSnapshot,
  type ComparisonItem,
  type ComparisonSnapshot,
  type ComparisonSummary,
} from "../api";
import { Window } from "../wm/Window";
import type { UnitControls, UnitView } from "../wm/Cluster";
import { baseName, errorMessage, formatDate, snapshotProblem } from "./common";
import {
  consolidatedPaths,
  existsOn,
  flattenRows,
  folderKeys,
  fullPath,
  pickedFiles,
  sidePicker,
  topLevelFolders,
  visibleItems,
  type Row,
  type Side,
  type StatusFilter,
} from "./compareTree";
import { pickDirectory } from "./pickDirectory";

const ROW_H = 20;
const OVERSCAN = 10;

type Phase = "setup" | "comparing" | "results" | "error";
type Mode = "tree" | "paths";

interface Result {
  comparisonId: string;
  sourcePath: string;
  targetPath: string;
  summary: ComparisonSummary;
  tree: ComparisonItem[];
}

const EMPTY_SUMMARY: ComparisonSummary = {
  identical: 0,
  modified: 0,
  missingFromTarget: 0,
  extraInTarget: 0,
  totalSourceSize: 0,
  totalTargetSize: 0,
};

function fromSnapshot(s: ComparisonSnapshot | null): Result | null {
  if (!s?.comparison) return null;
  return {
    comparisonId: s.scanId,
    sourcePath: s.rootPath,
    targetPath: s.targetPath || "",
    summary: s.comparisonSummary || EMPTY_SUMMARY,
    tree: s.comparison,
  };
}

const FILTERS: { id: StatusFilter; glyph: string; label: string; count: (s: ComparisonSummary) => number }[] = [
  { id: "identical", glyph: "=", label: "identical", count: (s) => s.identical },
  { id: "modified", glyph: "≠", label: "modified", count: (s) => s.modified },
  { id: "missing_from_target", glyph: "◀", label: "only in source", count: (s) => s.missingFromTarget },
  { id: "extra_in_target", glyph: "▶", label: "only in target", count: (s) => s.extraInTarget },
];

function glyphFor(side: Side, item: ComparisonItem): string {
  if (item.itemType === "folder") return "";
  switch (item.status) {
    case "identical":
      return "=";
    case "modified":
      return "≠";
    case "missing_from_target":
      return side === "source" ? "◀" : "";
    case "extra_in_target":
      return side === "target" ? "▶" : "";
  }
}

interface TreeBodyProps {
  side: Side;
  rows: Row[];
  height: number;
  scrollTop: number;
  onScroll: (top: number) => void;
  hover: string | null;
  onHover: (key: string | null) => void;
  expanded: Set<string>;
  onToggle: (key: string) => void;
}

/** One side's rows; only the ones in view are drawn. */
function TreeBody({ side, rows, height, scrollTop, onScroll, hover, onHover, expanded, onToggle }: TreeBodyProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Follow the partner window's scrolling.
  useEffect(() => {
    const el = ref.current;
    if (el && Math.abs(el.scrollTop - scrollTop) > 1) el.scrollTop = scrollTop;
  }, [scrollTop]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

  return (
    <div
      ref={ref}
      className="lcd cmp-tree"
      onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="cmp-spacer" style={{ height: rows.length * ROW_H }}>
        {rows.slice(first, last).map((row, i) => {
          const { item } = row;
          const present = existsOn(side, item);
          const folder = item.itemType === "folder";
          const size = side === "source" ? item.sourceSize : item.targetSize;
          const modified = side === "source" ? item.sourceModified : item.targetModified;
          const other = side === "source" ? item.targetModified : item.sourceModified;
          const newer = !folder && item.status === "modified" && !!modified && !!other && new Date(modified) > new Date(other);
          const tip = present
            ? `${row.key}${size != null ? `\n${formatBytes(size)}` : ""}${modified ? ` · modified ${formatDate(modified)}` : ""}`
            : `${row.key}\nnot in the ${side}`;
          return (
            <div
              key={row.key}
              className={[
                "cmp-row",
                `is-${item.status}`,
                folder ? "is-folder" : "is-file",
                present ? "" : "is-absent",
                hover === row.key ? "is-hover" : "",
              ].join(" ")}
              style={{ top: (first + i) * ROW_H, height: ROW_H }}
              title={tip}
              onMouseEnter={() => onHover(row.key)}
              onClick={() => folder && onToggle(row.key)}
            >
              <span className="cmp-indent" style={{ width: row.depth * 14 }} />
              <span className="cmp-twisty">{folder && present ? (expanded.has(row.key) ? "▾" : "▸") : ""}</span>
              <span className="cmp-name">{present ? item.name : ""}</span>
              {folder && present && item.differenceCount > 0 ? <span className="cmp-badge">{item.differenceCount}</span> : null}
              {newer ? <span className="cmp-newer">NEWER</span> : null}
              <span className="cmp-size">{present && !folder && size != null ? formatBytes(size) : ""}</span>
              <span className="cmp-glyph">{present ? glyphFor(side, item) : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ComparePairProps {
  view: UnitView;
  controls: UnitControls;
  snapshot: ComparisonSnapshot | null;
  connected: boolean;
  onSaved: (snapshot: ComparisonSnapshot) => void;
  onUpdated: (snapshot: ComparisonSnapshot) => void;
  onProblem: (snapshotId: string, problem: string | null) => void;
}

export function ComparePair({ view, controls, snapshot, connected, onSaved, onUpdated, onProblem }: ComparePairProps) {
  const initial = fromSnapshot(snapshot);
  const [phase, setPhase] = useState<Phase>(initial ? "results" : "setup");
  const [paths, setPaths] = useState<Record<Side, string>>({
    source: initial?.sourcePath ?? "",
    target: initial?.targetPath ?? "",
  });
  const [deepScan, setDeepScan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(initial);
  const [busy, setBusy] = useState<"saving" | "refreshing" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [diffOnly, setDiffOnly] = useState(false);
  const [mode, setMode] = useState<Mode>("tree");
  const [expanded, setExpanded] = useState<Set<string>>(() => topLevelFolders(initial?.tree ?? []));
  const [scrollTop, setScrollTop] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const refreshedRef = useRef(false);

  const snapshotId = snapshot?.id ?? null;
  const tree = useMemo(() => result?.tree ?? [], [result]);
  const shown = useMemo(() => visibleItems(tree, filter, diffOnly), [tree, filter, diffOnly]);
  const rows = useMemo(() => flattenRows(tree, expanded, shown), [tree, expanded, shown]);

  const refresh = async (id: string) => {
    setBusy("refreshing");
    try {
      const updated = await updateComparisonSnapshot(id);
      const next = fromSnapshot(updated);
      if (next) setResult(next);
      setProblem(null);
      onProblem(id, null);
      onUpdated(updated);
    } catch (err) {
      console.error("[Comparison] refresh failed:", err);
      const friendly = snapshotProblem(err);
      setProblem(friendly ?? `Couldn't refresh: ${errorMessage(err)}`);
      if (friendly) onProblem(id, friendly);
    } finally {
      setBusy(null);
    }
  };

  // A saved comparison opens as saved, then re-runs once to catch up.
  useEffect(() => {
    if (!snapshotId || !connected || refreshedRef.current) return;
    refreshedRef.current = true;
    void refresh(snapshotId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per window
  }, [snapshotId, connected]);

  const compare = async () => {
    const source = paths.source.trim();
    const target = paths.target.trim();
    if (!source || !target) return;
    setPhase("comparing");
    setError(null);
    try {
      const response = await compareDirectories(source, target, deepScan);
      setResult(response);
      setExpanded(topLevelFolders(response.tree));
      setFilter("all");
      setScrollTop(0);
      setPhase("results");
    } catch (err) {
      setError(errorMessage(err));
      setPhase("error");
    }
  };

  const save = async () => {
    if (!result) return;
    setBusy("saving");
    try {
      const saved = await saveComparisonSnapshot(result.sourcePath, result.targetPath, result.comparisonId);
      refreshedRef.current = true;
      onSaved(saved);
    } catch (err) {
      window.alert(`Couldn't save the comparison: ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (phase === "results" && !snapshotId && !window.confirm("This comparison isn't saved. Close it anyway?")) return;
    controls.close();
  };

  const chooseFilter = (next: StatusFilter) => {
    const value = filter === next ? "all" : next;
    setFilter(value);
    setScrollTop(0);
    // Open every folder that holds a match, so the matches are in view.
    if (value !== "all") setExpanded(folderKeys(tree, visibleItems(tree, value, diffOnly)));
  };

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const browse = async (side: Side) => {
    const picked = await pickDirectory();
    if (picked) setPaths((prev) => ({ ...prev, [side]: picked }));
  };

  const summary = result?.summary ?? EMPTY_SUMMARY;
  const differences = summary.modified + summary.missingFromTarget + summary.extraInTarget;
  const bodyHeight = view.rect.h;

  const renderSetup = (side: Side) => (
    <div className="cmp-setup">
      <div className="lcd lcd-banner">
        <span className="led" data-on={connected} />
        {phase === "error" ? (
          <span className="lcd-bad">COMPARE FAILED · {error}</span>
        ) : phase === "comparing" ? (
          <span className="lcd-accent blink">COMPARING…</span>
        ) : (
          <span>{side === "source" ? "1 · SOURCE folder" : "2 · TARGET folder, then compare"}</span>
        )}
      </div>
      {phase === "comparing" ? <div className="seekbar is-indeterminate"><span /></div> : null}
      <div className="field-row">
        <input
          className="lcd-input"
          value={paths[side]}
          placeholder={side === "source" ? "/path/to/original" : "/path/to/copy"}
          onChange={(e) => setPaths((prev) => ({ ...prev, [side]: e.target.value }))}
          onKeyDown={(e) => e.key === "Enter" && side === "target" && connected && void compare()}
          spellCheck={false}
          disabled={phase === "comparing"}
          aria-label={`${side} folder`}
        />
        <button type="button" className="steel-btn" onClick={() => browse(side)} disabled={phase === "comparing"}>
          BROWSE
        </button>
      </div>
      {side === "source" ? (
        <label className="check">
          <input type="checkbox" checked={deepScan} onChange={(e) => setDeepScan(e.target.checked)} disabled={phase === "comparing"} />
          Deep scan (verify contents with hashes)
        </label>
      ) : (
        <div className="field-row is-end">
          <button
            type="button"
            className="steel-btn is-primary"
            onClick={compare}
            disabled={!connected || phase === "comparing" || !paths.source.trim() || !paths.target.trim()}
          >
            COMPARE
          </button>
        </div>
      )}
    </div>
  );

  const renderPaths = (side: Side) => {
    if (!result) return null;
    const pick = sidePicker(side, filter);
    const files = pickedFiles(tree, pick);
    const list = consolidatedPaths(tree, pick);
    const base = side === "source" ? result.sourcePath : result.targetPath;
    return (
      <div className="lcd cmp-paths">
        <div className="cmp-paths-head">
          <span>
            {files.length} file{files.length === 1 ? "" : "s"} · {list.length} path{list.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="chip"
            disabled={!files.length}
            onClick={() => copy(`${side}-all`, files.map((f) => fullPath(base, f)).join("\n"))}
          >
            {copied === `${side}-all` ? "COPIED" : "COPY ALL"}
          </button>
        </div>
        {list.length === 0 ? (
          <div className="lcd-dim pad">Nothing on this side for this filter.</div>
        ) : (
          list.map((p) => {
            const folder = p.endsWith("/**");
            const id = `${side}:${p}`;
            return (
              <div key={p} className="cmp-path">
                <span className="cmp-path-text">
                  {folder ? p.slice(0, -3) : p}
                  {folder ? <span className="lcd-dim">/** (all contents)</span> : null}
                </span>
                <button type="button" className="chip" onClick={() => copy(id, fullPath(base, folder ? p.slice(0, -3) : p))}>
                  {copied === id ? "✓" : "COPY"}
                </button>
              </div>
            );
          })
        )}
      </div>
    );
  };

  const renderResults = (side: Side) => {
    if (!result) return null;
    const base = side === "source" ? result.sourcePath : result.targetPath;
    const total = side === "source" ? summary.totalSourceSize : summary.totalTargetSize;
    return (
      <div className="cmp-results">
        <div className="lcd cmp-head">
          <span className="cmp-side-tag">{side === "source" ? "SRC" : "TGT"}</span>
          <span className="lcd-ellipsis lcd-strong" title={base}>
            {base}
          </span>
          <span>{formatBytes(total)}</span>
          {busy === "refreshing" && side === "target" ? <span className="lcd-accent blink">REFRESHING</span> : null}
        </div>
        <div className="lcd-toolbar cmp-toolbar">
          {side === "source" ? (
            <div className="seg">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`seg-btn is-${f.id} ${filter === f.id ? "is-on" : ""}`}
                  onClick={() => chooseFilter(f.id)}
                  title={`Show only ${f.label}`}
                >
                  {f.glyph} {f.count(summary)}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="seg">
                <button type="button" className={`seg-btn ${mode === "tree" ? "is-on" : ""}`} onClick={() => setMode("tree")}>
                  TREE
                </button>
                <button type="button" className={`seg-btn ${mode === "paths" ? "is-on" : ""}`} onClick={() => setMode("paths")}>
                  PATHS
                </button>
              </div>
              <button
                type="button"
                className={`seg-btn ${diffOnly ? "is-on" : ""}`}
                onClick={() => setDiffOnly(!diffOnly)}
                title="Hide identical files"
                disabled={filter !== "all"}
              >
                DIFF {differences}
              </button>
              <button type="button" className="chip" onClick={() => setExpanded(folderKeys(tree, shown))} title="Expand all">
                +
              </button>
              <button type="button" className="chip" onClick={() => setExpanded(new Set())} title="Collapse all">
                −
              </button>
            </>
          )}
          <span className="spacer" />
          {side === "target" ? (
            snapshotId ? (
              <button type="button" className="steel-btn" onClick={() => void refresh(snapshotId)} disabled={!!busy || !connected}>
                UPDATE
              </button>
            ) : (
              <button type="button" className="steel-btn is-primary" onClick={save} disabled={!!busy}>
                {busy === "saving" ? "SAVING…" : "SAVE"}
              </button>
            )
          ) : filter !== "all" ? (
            <button type="button" className="chip" onClick={() => chooseFilter(filter)}>
              ✕ FILTER
            </button>
          ) : null}
        </div>
        {problem ? <div className="lcd lcd-bad scan-problem">⚠ {problem} · showing saved data</div> : null}
        {mode === "paths" ? (
          renderPaths(side)
        ) : rows.length === 0 ? (
          <div className="lcd cmp-tree">
            <div className="lcd-dim pad">
              {differences === 0 && filter === "all" ? "The folders match: every file is identical." : "Nothing matches this filter."}
            </div>
          </div>
        ) : (
          <TreeBody
            side={side}
            rows={rows}
            height={bodyHeight}
            scrollTop={scrollTop}
            onScroll={setScrollTop}
            hover={hover}
            onHover={setHover}
            expanded={expanded}
            onToggle={toggle}
          />
        )}
      </div>
    );
  };

  const sizes = view.unit.sizes;
  const left = { ...view.rect, w: sizes[0].w };
  const right = { ...view.rect, x: view.rect.x + sizes[0].w, w: sizes[1].w };
  const name = (side: Side) => baseName((side === "source" ? result?.sourcePath : result?.targetPath) || paths[side]);
  const shadeInfo = result ? `${differences} difference${differences === 1 ? "" : "s"}` : undefined;

  return (
    <>
      {(["source", "target"] as Side[]).map((side, member) => (
        <Window
          key={side}
          title={`${side === "source" ? "SOURCE ◂" : "▸ TARGET"}${name(side) ? ` · ${name(side)}` : ""}`}
          shadeInfo={side === "source" ? shadeInfo : undefined}
          view={view}
          controls={controls}
          rect={member === 0 ? left : right}
          member={member}
          className={`kind-compare ${member === 0 ? "is-pair-left" : "is-pair-right"}`}
          onClose={close}
        >
          {phase === "results" ? renderResults(side) : renderSetup(side)}
        </Window>
      ))}
    </>
  );
}
