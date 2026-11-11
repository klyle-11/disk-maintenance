/**
 * Comparing in one window: the two folders (folded away once there are
 * results), the summary and filters, and the source and target trees side by
 * side, row for row like a diff, sharing one scroll position.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, type ComparisonItem } from "../api";
import { useApp } from "../state/app";
import { showInDhm } from "../state/dhm";
import { openScanSnapshot, savedScanOf, scanFolder } from "../state/scan";
import {
  chooseFilter,
  closeCompare,
  COMPARE,
  compareWith,
  EMPTY_SUMMARY,
  patchCompare,
  refreshCompare,
  runCompare,
  saveCompare,
  toggleFolder,
  useCompare,
  type CompareSession,
} from "../state/compare";
import { Window } from "../wm/Window";
import { baseName, formatDate } from "./common";
import {
  consolidatedPaths,
  existsOn,
  flattenRows,
  folderKeys,
  fullPath,
  pickedFiles,
  sidePicker,
  visibleItems,
  type Row,
  type Side,
  type StatusFilter,
} from "./compareTree";
import { FolderChoice } from "./FolderChoice";
import type { WindowArgs } from "./HubWindows";
import { pickDirectory } from "./pickDirectory";
import { Section } from "./Section";

const ROW_H = 20;
const OVERSCAN = 10;

const FILTERS: { id: StatusFilter; glyph: string; label: string; count: (s: typeof EMPTY_SUMMARY) => number }[] = [
  { id: "identical", glyph: "=", label: "identical", count: (s) => s.identical },
  { id: "modified", glyph: "≠", label: "modified", count: (s) => s.modified },
  { id: "missing_from_target", glyph: "◀", label: "only in source", count: (s) => s.missingFromTarget },
  { id: "extra_in_target", glyph: "▶", label: "only in target", count: (s) => s.extraInTarget },
];

export function CompareWindow({ view, controls }: WindowArgs) {
  const id = COMPARE;
  const s = useCompare(COMPARE);
  const ready = useApp((a) => a.connected === true);
  if (!s) return null;

  const busy = s.phase === "comparing";
  const summary = s.result?.summary ?? EMPTY_SUMMARY;
  const differences = summary.modified + summary.missingFromTarget + summary.extraInTarget;
  const tree = s.result?.tree ?? [];
  const browse = async (side: Side) => {
    const picked = await pickDirectory();
    if (picked) patchCompare(id, (c) => ({ paths: { ...c.paths, [side]: picked } }));
  };
  const foldersInfo =
    s.paths.source || s.paths.target ? `${baseName(s.paths.source) || "?"} ⇄ ${baseName(s.paths.target) || "?"}` : undefined;

  return (
    <Window
      title={s.result ? `COMPARE · ${baseName(s.result.sourcePath)} ⇄ ${baseName(s.result.targetPath)}` : "COMPARE"}
      shadeInfo={s.result ? `${differences} differences` : undefined}
      view={view}
      controls={controls}
      className="kind-compare"
      onClose={() => void closeCompare()}
    >
      <div className="tool">
        <Section
          title="FOLDERS"
          info={foldersInfo}
          open={s.foldersOpen || !s.result}
          onToggle={() => patchCompare(id, { foldersOpen: !s.foldersOpen })}
        >
          <div className="cmp-folders">
            {(["source", "target"] as Side[]).map((side) => (
              <div className="field-row" key={side}>
                <span className="field-tag">{side === "source" ? "SRC" : "TGT"}</span>
                <input
                  className="lcd-input"
                  value={s.paths[side]}
                  placeholder={side === "source" ? "/path/to/original" : "/path/to/copy"}
                  onChange={(e) => patchCompare(id, (c) => ({ paths: { ...c.paths, [side]: e.target.value } }))}
                  onKeyDown={(e) => e.key === "Enter" && ready && !busy && void runCompare(id)}
                  spellCheck={false}
                  disabled={busy}
                  aria-label={`${side} folder`}
                />
                <button type="button" className="steel-btn" onClick={() => browse(side)} disabled={busy}>
                  BROWSE
                </button>
                <FolderChoice
                  label="RECENT"
                  className="cmp-recent"
                  exclude={[s.paths.source, s.paths.target]}
                  disabled={busy}
                  title={`Pick the ${side} from saved scans and recent folders`}
                  onPick={(picked) => patchCompare(id, (c) => ({ paths: { ...c.paths, [side]: picked } }))}
                />
              </div>
            ))}
            <div className="field-row">
              <label className="field">
                <input type="checkbox" checked={s.deepScan} onChange={(e) => patchCompare(id, { deepScan: e.target.checked })} disabled={busy} />
                DEEP (HASHES)
              </label>
              <span className="spacer" />
              <button
                type="button"
                className="steel-btn is-primary"
                onClick={() => void runCompare(id)}
                disabled={!ready || busy || !s.paths.source.trim() || !s.paths.target.trim()}
              >
                {busy ? "COMPARING…" : "COMPARE"}
              </button>
            </div>
          </div>
        </Section>

        {busy ? (
          <div className="seekbar is-indeterminate">
            <span />
          </div>
        ) : null}
        {s.phase === "error" ? <div className="lcd lcd-bad lcd-ellipsis">FAILED · {s.error}</div> : null}
        {!s.result && s.phase === "setup" ? (
          <div className="lcd lcd-banner">
            <span className="lcd-dim">
              {!ready
                ? "Waiting for the backend…"
                : s.paths.source.trim() && !s.paths.target.trim()
                  ? "Now pick the target: BROWSE, RECENT, or ⇄ on a folder in DU-HAST-MUCH."
                  : "Pick a source and a target folder, then COMPARE."}
            </span>
          </div>
        ) : null}

        {s.result ? (
          <>
            <div className="field-row">
              <div className="seg is-wide">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`seg-btn is-${f.id} ${s.filter === f.id ? "is-on" : ""}`}
                    onClick={() => chooseFilter(id, f.id)}
                    title={`Show only ${f.label} (again to clear)`}
                  >
                    {f.glyph} {f.count(summary)}
                  </button>
                ))}
              </div>
            </div>
            <div className="field-row">
              <div className="seg">
                <button type="button" className={`seg-btn ${s.mode === "tree" ? "is-on" : ""}`} onClick={() => patchCompare(id, { mode: "tree" })}>
                  TREE
                </button>
                <button type="button" className={`seg-btn ${s.mode === "paths" ? "is-on" : ""}`} onClick={() => patchCompare(id, { mode: "paths" })}>
                  PATHS
                </button>
              </div>
              <button
                type="button"
                className={`seg-btn ${s.diffOnly ? "is-on" : ""}`}
                onClick={() => patchCompare(id, { diffOnly: !s.diffOnly })}
                disabled={s.filter !== "all"}
                title="Hide identical files"
              >
                DIFF
              </button>
              <button
                type="button"
                className="chip"
                title="Expand all"
                onClick={() => patchCompare(id, (c) => ({ expanded: folderKeys(tree, visibleItems(tree, c.filter, c.diffOnly)) }))}
              >
                +
              </button>
              <button type="button" className="chip" title="Collapse all" onClick={() => patchCompare(id, { expanded: new Set() })}>
                −
              </button>
              <span className="spacer" />
              <FolderChoice
                label="SRC VS…"
                className="is-chip"
                exclude={[s.result.sourcePath, s.result.targetPath]}
                disabled={busy}
                title={`Compare ${s.result.sourcePath} with another folder instead`}
                onPick={(target) => void compareWith(s.result!.sourcePath, target)}
              />
              {s.busy === "refreshing" ? (
                <span className="lcd-accent blink">REFRESHING</span>
              ) : s.problem ? (
                <span className="lcd-bad lcd-ellipsis" title={s.problem}>
                  ⚠ {s.problem}
                </span>
              ) : null}
              {s.snapshotId ? (
                <button type="button" className="steel-btn" onClick={() => void refreshCompare(id)} disabled={!!s.busy || !ready}>
                  UPDATE
                </button>
              ) : (
                <button type="button" className="steel-btn is-primary" onClick={() => void saveCompare(id)} disabled={!!s.busy}>
                  {s.busy === "saving" ? "…" : "SAVE"}
                </button>
              )}
            </div>
            <CompareTrees session={s} />
          </>
        ) : null}
      </div>
    </Window>
  );
}

/** A side's way back out: its scan (the saved one, or a new one) and DU-HAST-MUCH. */
function SideLinks({ path }: { path: string }) {
  const saved = useApp((a) => savedScanOf(a.snapshots, path));
  const name = baseName(path);
  return (
    <>
      <button
        type="button"
        className="chip"
        onClick={() => void (saved ? openScanSnapshot(saved) : scanFolder(path))}
        title={saved ? `Open the saved scan of ${name}` : `Scan ${name} in SCAN`}
      >
        SCAN
      </button>
      <button type="button" className="chip" onClick={() => showInDhm(path)} title={`See ${name}'s biggest subfolders in DU-HAST-MUCH`}>
        DHM
      </button>
    </>
  );
}

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
  session: string;
  side: Side;
  rows: Row[];
  height: number;
  scrollTop: number;
  hover: string | null;
  expanded: Set<string>;
}

/** One side's rows; only the ones in view are drawn. */
function TreeBody({ session, side, rows, height, scrollTop, hover, expanded }: TreeBodyProps) {
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
      onScroll={(e) => patchCompare(session, { scrollTop: e.currentTarget.scrollTop })}
      onMouseLeave={() => patchCompare(session, { hover: null })}
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
              onMouseEnter={() => patchCompare(session, { hover: row.key })}
              onClick={() => folder && toggleFolder(session, row.key)}
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

function PathList({ base, tree, side, filter }: { base: string; tree: ComparisonItem[]; side: Side; filter: StatusFilter }) {
  const [copied, setCopied] = useState<string | null>(null);
  const pick = sidePicker(side, filter);
  const files = pickedFiles(tree, pick);
  const list = consolidatedPaths(tree, pick);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };
  return (
    <div className="lcd cmp-paths">
      <div className="cmp-paths-head">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"} · {list.length} path{list.length === 1 ? "" : "s"}
        </span>
        <button type="button" className="chip" disabled={!files.length} onClick={() => copy("all", files.map((f) => fullPath(base, f)).join("\n"))}>
          {copied === "all" ? "COPIED" : "COPY ALL"}
        </button>
      </div>
      {list.length === 0 ? <div className="lcd-dim pad">Nothing on this side for this filter.</div> : null}
      {list.map((p) => {
        const folder = p.endsWith("/**");
        const clean = folder ? p.slice(0, -3) : p;
        return (
          <div key={p} className="cmp-path">
            <span className="cmp-path-text">
              {clean}
              {folder ? <span className="lcd-dim">/** (all contents)</span> : null}
            </span>
            <button type="button" className="chip" onClick={() => copy(p, fullPath(base, clean))}>
              {copied === p ? "✓" : "COPY"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Follow an element's height (the trees only draw the rows in view). */
function useHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}

/** The source and target side by side. */
function CompareTrees({ session: s }: { session: CompareSession }) {
  const tree = useMemo(() => s.result?.tree ?? [], [s.result]);
  const shown = useMemo(() => visibleItems(tree, s.filter, s.diffOnly), [tree, s.filter, s.diffOnly]);
  const rows = useMemo(() => flattenRows(tree, s.expanded, shown), [tree, s.expanded, shown]);
  const { ref, height } = useHeight();
  if (!s.result) return null;
  const result = s.result;
  const differences = result.summary.modified + result.summary.missingFromTarget + result.summary.extraInTarget;

  return (
    <div className="cmp-split" ref={ref}>
      {(["source", "target"] as Side[]).map((side) => {
        const base = side === "source" ? result.sourcePath : result.targetPath;
        const total = side === "source" ? result.summary.totalSourceSize : result.summary.totalTargetSize;
        return (
          <div key={side} className="cmp-side">
            <div className="lcd cmp-head">
              <span className="cmp-side-tag">{side === "source" ? "SRC" : "TGT"}</span>
              <span className="lcd-ellipsis lcd-strong" title={base}>
                {base}
              </span>
              <span>{formatBytes(total)}</span>
              <SideLinks path={base} />
            </div>
            {s.mode === "paths" ? (
              <PathList base={base} tree={tree} side={side} filter={s.filter} />
            ) : rows.length === 0 ? (
              <div className="lcd cmp-tree">
                <div className="lcd-dim pad">
                  {differences === 0 && s.filter === "all" ? "The folders match: every file is identical." : "Nothing matches this filter."}
                </div>
              </div>
            ) : (
              <TreeBody
                session={s.id}
                side={side}
                rows={rows}
                height={height}
                scrollTop={s.scrollTop}
                hover={s.hover}
                expanded={s.expanded}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
