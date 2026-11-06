/**
 * du-hast-much in one window: the folder and options on top, the CLI-style
 * table below. Sized so the controls and a top-10 table fit without scrolling.
 */
import { useEffect, useMemo, useRef } from "react";
import { formatBytes } from "../api";
import { ansiCss, parseAnsi } from "../ansi";
import { useApp } from "../state/app";
import { dhmLines, patchDhm, runDhm, showDhmRecord, stopDhm, timeAgo, useDhm } from "../state/dhm";
import { Window } from "../wm/Window";
import { baseName } from "./common";
import type { WindowArgs } from "./HubWindows";
import { pickDirectory } from "./pickDirectory";

export function DhmWindow({ view, controls }: WindowArgs) {
  const ready = useApp((s) => s.connected === true);
  const path = useDhm((s) => s.path);
  const depth = useDhm((s) => s.depth);
  const top = useDhm((s) => s.top);
  const latest = useDhm((s) => s.latest);
  const running = useDhm((s) => s.running);
  const error = useDhm((s) => s.error);
  const history = useDhm((s) => s.history);
  const results = useDhm((s) => s.results);
  const meta = useDhm((s) => s.meta);
  const shown = useDhm((s) => s.shown);
  const lines = useMemo(() => dhmLines({ results, meta, running, shown }), [results, meta, running, shown]);
  const outputRef = useRef<HTMLDivElement>(null);

  // Follow the table as it fills in.
  useEffect(() => {
    if (running && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines, running]);

  const run = () => void runDhm();
  const title = shown ? `DU-HAST-MUCH · ${baseName(shown.path)}` : "DU-HAST-MUCH";
  const shadeInfo = running ? `scanning · ${results.length} dirs` : meta ? formatBytes(meta.totalSize) : path;

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
          <label className="field">
            DEPTH
            <input
              type="number"
              min={1}
              max={10}
              className="lcd-input is-num"
              value={depth}
              onChange={(e) => patchDhm({ depth: parseInt(e.target.value) || 1 })}
            />
          </label>
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
              if (record) showDhmRecord(record);
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
          {lines.length === 0 && !error ? (
            <div className="lcd-dim">{running ? "Scanning…" : ready ? "Pick a folder and press SCAN." : "Waiting for the backend…"}</div>
          ) : (
            lines.map((line, i) => (
              <div key={i} className="term-line">
                {parseAnsi(line).segments.map((seg, j) => (
                  <span key={j} style={ansiCss(seg.style)}>
                    {seg.text}
                  </span>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </Window>
  );
}
