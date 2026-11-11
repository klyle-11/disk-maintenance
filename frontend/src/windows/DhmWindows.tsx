/**
 * du-hast-much in one window: the folder and options on top, the CLI-style
 * table below. Click a folder's row to open it, BACK to return; each row's
 * buttons copy its path or send it to the scan window. Sized so the controls
 * and a top-10 table fit without scrolling.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "../api";
import { ansiCss, parseAnsi } from "../ansi";
import { useApp } from "../state/app";
import { copyText } from "../desktop";
import {
  backTarget,
  dhmBack,
  dhmLines,
  openDhmFolder,
  patchDhm,
  runDhm,
  stopDhm,
  timeAgo,
  useDhm,
} from "../state/dhm";
import { addToCompare, useWaitingSource } from "../state/compare";
import { openScanSnapshot, pathKey, savedScanOf, scanFolder } from "../state/scan";
import { Window } from "../wm/Window";
import { baseName } from "./common";
import type { WindowArgs } from "./HubWindows";
import { pickDirectory } from "./pickDirectory";

const ICON = { width: 9, height: 9, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1.3 } as const;

const CopyIcon = () => (
  <svg {...ICON} aria-hidden>
    <rect x="3.5" y="0.75" width="5.75" height="5.75" />
    <path d="M1.5 3.5v5.75h5.75" />
  </svg>
);

const OpenIcon = () => (
  <svg {...ICON} aria-hidden>
    <path d="M0.75 5h8M5.75 2l3 3-3 3" />
  </svg>
);

const CompareIcon = () => (
  <svg {...ICON} aria-hidden>
    <path d="M0.75 3h8M6.5 0.75 8.75 3 6.5 5.25" />
    <path d="M9.25 7h-8M3.5 4.75 1.25 7l2.25 2.25" />
  </svg>
);

const UpdateIcon = () => (
  <svg {...ICON} aria-hidden>
    <path d="M8.6 4.2A3.75 3.75 0 1 0 8.5 6.4" />
    <path d="M9.25 1.5v3h-3" />
  </svg>
);

/**
 * A row's buttons: copy its full path, scan it in the scan window (or, once
 * it has a saved scan, update that snapshot), and compare it: the first
 * folder picked waits in COMPARE, the next one is compared with it.
 */
function RowActions({ path, copied, onCopy }: { path: string; copied: boolean; onCopy: (path: string) => void }) {
  const saved = useApp((s) => savedScanOf(s.snapshots, path));
  const waiting = useWaitingSource();
  const name = baseName(path);
  const pairs = !!waiting && pathKey(waiting) !== pathKey(path);
  const compareLabel = pairs ? `Compare ${baseName(waiting!)} with ${name}` : `Compare ${name} with another folder (pick it next)`;
  return (
    <span className="dhm-actions" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="dhm-act" title={copied ? "Copied" : `Copy ${path}`} aria-label={`Copy the path of ${name}`} onClick={() => onCopy(path)}>
        {copied ? "✓" : <CopyIcon />}
      </button>
      <button
        type="button"
        className={`dhm-act ${saved ? "is-update" : ""}`}
        title={
          saved
            ? `Update the saved scan of ${name} (saved ${timeAgo(Date.parse(saved.savedAt) / 1000)})`
            : `Scan ${name} in SCAN`
        }
        aria-label={saved ? `Update the saved scan of ${name}` : `Scan ${name} in SCAN`}
        onClick={() => void (saved ? openScanSnapshot(saved) : scanFolder(path))}
      >
        {saved ? <UpdateIcon /> : <OpenIcon />}
      </button>
      <button
        type="button"
        className={`dhm-act ${pairs ? "is-update" : ""}`}
        title={compareLabel}
        aria-label={compareLabel}
        onClick={() => void addToCompare(path)}
      >
        <CompareIcon />
      </button>
    </span>
  );
}

export function DhmWindow({ view, controls }: WindowArgs) {
  const ready = useApp((s) => s.connected === true);
  const path = useDhm((s) => s.path);
  const top = useDhm((s) => s.top);
  const latest = useDhm((s) => s.latest);
  const running = useDhm((s) => s.running);
  const error = useDhm((s) => s.error);
  const history = useDhm((s) => s.history);
  const results = useDhm((s) => s.results);
  const meta = useDhm((s) => s.meta);
  const shown = useDhm((s) => s.shown);
  const shownAt = useDhm((s) => s.shownAt);
  const refreshing = useDhm((s) => s.refreshing);
  const back = useDhm(backTarget);
  const lines = useMemo(
    () => dhmLines({ results, meta, running, shown, refreshing, shownAt }),
    [results, meta, running, shown, refreshing, shownAt],
  );
  const outputRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (path: string) => {
    if (!(await copyText(path))) return;
    setCopied(path);
    setTimeout(() => setCopied((c) => (c === path ? null : c)), 1400);
  };

  // Follow the table as it fills in (not while remembered rows are shown).
  useEffect(() => {
    if (running && !refreshing && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines, running, refreshing]);

  const run = () => void runDhm();
  const title = shown ? `DU-HAST-MUCH · ${baseName(shown.path)}` : "DU-HAST-MUCH";
  const shadeInfo = running && !refreshing ? `scanning · ${results.length} dirs` : meta ? formatBytes(meta.totalSize) : path;
  const empty = !!shown && !running && !error && results.length === 0 && !!meta;

  return (
    <Window title={title} shadeInfo={shadeInfo} view={view} controls={controls} className="kind-dhm">
      <div className="tool">
        <div className="field-row">
          <span className={`led ${running ? "is-busy" : error ? "is-bad" : ""}`} data-on={ready} />
          <input
            className="lcd-input"
            value={path}
            placeholder="/path/to/folder"
            onChange={(e) => patchDhm({ path: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && ready && !running && run()}
            spellCheck={false}
            aria-label="Folder"
            disabled={running}
          />
          <button
            type="button"
            className="steel-btn"
            disabled={running}
            onClick={async () => {
              const picked = await pickDirectory();
              if (picked) patchDhm({ path: picked });
            }}
          >
            BROWSE
          </button>
          {running ? (
            <button type="button" className="steel-btn is-warn" onClick={stopDhm}>
              STOP
            </button>
          ) : (
            <button type="button" className="steel-btn is-primary" onClick={run} disabled={!ready || !path.trim()}>
              SCAN
            </button>
          )}
        </div>
        <div className="field-row">
          <button
            type="button"
            className="steel-btn"
            onClick={dhmBack}
            disabled={!back}
            title={back ? `Back to ${back}` : "Nothing to go back to"}
          >
            ◀ BACK
          </button>
          <label className="field">
            TOP
            <input
              type="number"
              min={1}
              className="lcd-input is-num"
              value={top ?? ""}
              placeholder="all"
              onChange={(e) => patchDhm({ top: parseInt(e.target.value) || null })}
            />
          </label>
          <label className="field">
            <input type="checkbox" checked={latest} onChange={(e) => patchDhm({ latest: e.target.checked })} />
            LATEST
          </label>
          <span className="spacer" />
          <select
            className="lcd-input dhm-recent"
            value=""
            aria-label="Recent scans"
            disabled={running || history.length === 0}
            onChange={(e) => {
              const record = history.find((r) => String(r.timestamp) === e.target.value);
              if (record) openDhmFolder(record.path);
            }}
          >
            <option value="">{history.length ? `RECENT (${history.length})` : "NO RECENT SCANS"}</option>
            {history.map((r) => (
              <option key={r.timestamp} value={r.timestamp}>
                {baseName(r.path)} · {formatBytes(r.total_size)} · {timeAgo(r.timestamp / 1000)}
              </option>
            ))}
          </select>
        </div>
        <div className="lcd term dhm-out" ref={outputRef}>
          {error ? <div className="lcd-bad">{error}</div> : null}
          {empty ? <div className="lcd-dim">No folders inside {shown?.path}. ◀ BACK to go back.</div> : null}
          {lines.length === 0 && !error && !empty ? (
            <div className="lcd-dim">{running ? "Scanning…" : ready ? "Pick a folder and press SCAN." : "Waiting for the backend…"}</div>
          ) : (
            lines.map((line, i) => (
              <div
                key={i}
                className={`term-line ${line.path ? "is-link" : ""}`}
                title={line.path ? `Open ${line.path}` : undefined}
                onClick={line.path ? () => openDhmFolder(line.path!) : undefined}
              >
                {parseAnsi(line.text).segments.map((seg, j) => (
                  <span key={j} style={ansiCss(seg.style)}>
                    {seg.text}
                  </span>
                ))}
                {line.path ? <RowActions path={line.path} copied={copied === line.path} onCopy={copy} /> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </Window>
  );
}
