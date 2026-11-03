/** du-hast-much as two windows: its settings, and the CLI-style output. */
import { useEffect, useMemo, useRef } from "react";
import { formatBytes } from "../api";
import { ansiCss, parseAnsi } from "../ansi";
import { useApp } from "../state/app";
import { dhmLines, patchDhm, runDhm, showDhmRecord, stopDhm, timeAgo, useDhm } from "../state/dhm";
import { useStore } from "../store";
import { openWindow, wmStore } from "../wm/state";
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
  const found = useDhm((s) => s.results.length);
  const history = useDhm((s) => s.history);
  const outputOpen = useStore(wmStore, (s) => s.units.some((u) => u.id === "dhm-out"));

  const run = () => {
    if (!outputOpen) openWindow("dhm-out", "dhm-out", { parent: "dhm" });
    void runDhm();
  };

  return (
    <Window title="DU-HAST-MUCH" shadeInfo={running ? `scanning · ${found} dirs` : path} view={view} controls={controls} className="kind-dhm">
      <div className="tool">
        <div className="lcd lcd-banner">
          <span className={`led ${running ? "is-busy" : error ? "is-bad" : ""}`} data-on={ready} />
          {error ? (
            <span className="lcd-bad">{error}</span>
          ) : (
            <span>{running ? `SCANNING · ${found} DIRS` : ready ? "FOLDER SIZES" : "WAITING FOR BACKEND"}</span>
          )}
        </div>
        <div className="field-row">
          <input
            className="lcd-input"
            value={path}
            placeholder="/path/to/folder"
            onChange={(e) => patchDhm({ path: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && ready && run()}
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
        <div className="lcd mini-list" aria-label="Recent scans">
          {history.length === 0 ? <div className="lcd-dim">recent scans show here</div> : null}
          {history.map((record) => (
            <button
              key={record.timestamp}
              type="button"
              className="mini-row"
              onClick={() => {
                showDhmRecord(record);
                if (!outputOpen) openWindow("dhm-out", "dhm-out", { parent: "dhm" });
              }}
              title={record.path}
            >
              <span className="mini-name">{baseName(record.path)}</span>
              <span className="lcd-dim">{formatBytes(record.total_size)}</span>
              <span className="lcd-dim">{timeAgo(record.timestamp / 1000)}</span>
            </button>
          ))}
        </div>
      </div>
    </Window>
  );
}

export function DhmOutWindow({ view, controls }: WindowArgs) {
  const results = useDhm((s) => s.results);
  const meta = useDhm((s) => s.meta);
  const running = useDhm((s) => s.running);
  const shown = useDhm((s) => s.shown);
  const lines = useMemo(() => dhmLines({ results, meta, running, shown }), [results, meta, running, shown]);
  const ref = useRef<HTMLDivElement>(null);

  // Follow the table as it fills in.
  useEffect(() => {
    if (running && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, running]);

  return (
    <Window
      title={shown ? `DHM · ${baseName(shown.path)}` : "DHM · OUTPUT"}
      shadeInfo={meta ? formatBytes(meta.totalSize) : undefined}
      view={view}
      controls={controls}
      className="kind-dhm-out"
    >
      <div className="lcd term" ref={ref}>
        {lines.length === 0 ? (
          <div className="lcd-dim">{running ? "Scanning…" : "Pick a folder in DU-HAST-MUCH and press SCAN."}</div>
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
    </Window>
  );
}
