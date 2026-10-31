/**
 * A comparison as a control window (folders, filters, save) and a pair of
 * tree windows docked side by side: the source on the left, the target on the
 * right, row for row like a diff, sharing one scroll position.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, type ComparisonItem } from "../api";
import { useApp } from "../state/app";
import {
  chooseFilter,
  closeCompare,
  EMPTY_SUMMARY,
  pairId,
  patchCompare,
  refreshCompare,
  runCompare,
  saveCompare,
  toggleFolder,
  useCompare,
} from "../state/compare";
import { useStore } from "../store";
import { closeWindow, openWindow, wmStore } from "../wm/state";
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
import type { WindowArgs } from "./HubWindows";
import { pickDirectory } from "./pickDirectory";

const ROW_H = 20;
const OVERSCAN = 10;

const FILTERS: { id: StatusFilter; glyph: string; label: string; count: (s: typeof EMPTY_SUMMARY) => number }[] = [
  { id: "identical", glyph: "=", label: "identical", count: (s) => s.identical },
  { id: "modified", glyph: "≠", label: "modified", count: (s) => s.modified },
  { id: "missing_from_target", glyph: "◀", label: "only in source", count: (s) => s.missingFromTarget },
  { id: "extra_in_target", glyph: "▶", label: "only in target", count: (s) => s.extraInTarget },
];

export function CompareWindow({ view, controls }: WindowArgs) {
  const id = view.unit.id;
  const s = useCompare(view.unit.ref);
  const ready = useApp((a) => a.connected === true);
  const pairOpen = useStore(wmStore, (w) => w.units.some((u) => u.id === pairId(id)));
  if (!s) return null;

  const busy = s.phase === "comparing";
  const summary = s.result?.summary ?? EMPTY_SUMMARY;
  const differences = summary.modified + summary.missingFromTarget + summary.extraInTarget;
  const tree = s.result?.tree ?? [];
  const browse = async (side: Side) => {
    const picked = await pickDirectory();
    if (picked) patchCompare(id, (c) => ({ paths: { ...c.paths, [side]: picked } }));
  };

  return (
    <Window
      title={s.result ? `COMPARE · ${baseName(s.result.sourcePath)} ⇄ ${baseName(s.result.targetPath)}` : "COMPARE"}
      shadeInfo={s.result ? `${differences} differences` : undefined}
      view={view}
      controls={controls}
      className="kind-compare"
      onClose={() => closeCompare(id)}
    >
      <div className="tool">
        {s.phase !== "results" ? (
          <>
            <div className="lcd lcd-banner">
              <span className={`led ${busy ? "is-busy" : s.phase === "error" ? "is-bad" : ""}`} data-on={ready} />
              {s.phase === "error" ? (
                <span className="lcd-bad">FAILED · {s.error}</span>
              ) : (
                <span>{busy ? "COMPARING…" : "SOURCE ⇄ TARGET"}</span>
              )}
            </div>
            {busy ? <div className="seekbar is-indeterminate"><span /></div> : null}
            {(["source", "target"] as Side[]).map((side) => (
              <div className="field-row" key={side}>
                <span className="field-tag">{side === "source" ? "SRC" : "TGT"}</span>
                <input
                  className="lcd-input"
                  value={s.paths[side]}
                  placeholder={side === "source" ? "/path/to/original" : "/path/to/copy"}
                  onChange={(e) => patchCompare(id, (c) => ({ paths: { ...c.paths, [side]: e.target.value } }))}
                  onKeyDown={(e) => e.key === "Enter" && ready && void runCompare(id)}
                  spellCheck={false}
                  disabled={busy}
                  aria-label={`${side} folder`}
                />
                <button type="button" className="steel-btn" onClick={() => browse(side)} disabled={busy}>
                  BROWSE
                </button>
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
                COMPARE
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="lcd readout">
              <div className="stats">
                <span className="lcd-strong">{formatBytes(summary.totalSourceSize)}</span>
                <span className="lcd-dim">⇄</span>
                <span className="lcd-strong">{formatBytes(summary.totalTargetSize)}</span>
                <span className="spacer" />
                <span>{differences} diff</span>
              </div>
              {s.busy === "refreshing" ? (
                <div className="lcd-accent blink">REFRESHING</div>
              ) : s.problem ? (
                <div className="lcd-bad lcd-ellipsis" title={s.problem}>
                  ⚠ {s.problem}
                </div>
              ) : (
                <div className="lcd-dim">{s.snapshotId ? "saved" : "not saved"}</div>
              )}
            </div>
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
            </div>
            <div className="field-row">
              <button
                type="button"
                className={`steel-btn is-toggle ${pairOpen ? "is-on" : ""}`}
                onClick={() => (pairOpen ? closeWindow(pairId(id)) : openWindow("cmp-pair", pairId(id), { ref: id, parent: id }))}
                title="Show the source and target windows"
              >
                <span className="btn-led" />
                TREES
              </button>
              <span className="spacer" />
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
          </>
        )}
      </div>
    </Window>
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

export function ComparePairWindows({ view, controls }: WindowArgs) {
  const s = useCompare(view.unit.ref);
  const tree = useMemo(() => s?.result?.tree ?? [], [s?.result]);
  const filter = s?.filter ?? "all";
  const diffOnly = s?.diffOnly ?? false;
  const expanded = s?.expanded;
  const shown = useMemo(() => visibleItems(tree, filter, diffOnly), [tree, filter, diffOnly]);
  const rows = useMemo(() => flattenRows(tree, expanded ?? new Set(), shown), [tree, expanded, shown]);
  if (!s?.result) return null;
  const result = s.result;

  const sizes = view.unit.sizes;
  const left = { ...view.rect, w: sizes[0].w };
  const right = { ...view.rect, x: view.rect.x + sizes[0].w, w: sizes[1].w };
  const differences = result.summary.modified + result.summary.missingFromTarget + result.summary.extraInTarget;

  return (
    <>
      {(["source", "target"] as Side[]).map((side, member) => {
        const base = side === "source" ? result.sourcePath : result.targetPath;
        const total = side === "source" ? result.summary.totalSourceSize : result.summary.totalTargetSize;
        return (
          <Window
            key={side}
            title={`${side === "source" ? "SOURCE ◂" : "▸ TARGET"} · ${baseName(base)}`}
            shadeInfo={side === "source" ? `${differences} differences` : undefined}
            view={view}
            controls={controls}
            rect={member === 0 ? left : right}
            member={member}
            className={`kind-cmp-pair ${member === 0 ? "is-pair-left" : "is-pair-right"}`}
          >
            <div className="cmp-side">
              <div className="lcd cmp-head">
                <span className="cmp-side-tag">{side === "source" ? "SRC" : "TGT"}</span>
                <span className="lcd-ellipsis lcd-strong" title={base}>
                  {base}
                </span>
                <span>{formatBytes(total)}</span>
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
                  height={view.rect.h}
                  scrollTop={s.scrollTop}
                  hover={s.hover}
                  expanded={s.expanded}
                />
              )}
            </div>
          </Window>
        );
      })}
    </>
  );
}
