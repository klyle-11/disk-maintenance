/**
 * The hub: status display, and the buttons that open every other window.
 * It is the one window that can't be closed, so the cluster always has a
 * piece to dock onto.
 */
import { useEffect, useState } from "react";
import { formatBytes, getSpaceTips } from "../api";
import type { BackendStatus } from "../electron.d";
import { BackendStatus as BackendStatusPanel } from "../components/BackendStatus";
import { Window } from "../wm/Window";
import type { UnitControls, UnitView } from "../wm/Cluster";
import type { Kind } from "../wm/state";
import { SKINS, type Skin } from "../skins";

/** Windows the hub toggles, in button order. */
const TOGGLES: { kind: Kind; label: string; title: string }[] = [
  { kind: "dhm", label: "DHM", title: "du-hast-much: folder sizes, CLI style" },
  { kind: "di", label: "DI", title: "di: the Disk Intelligence command line" },
  { kind: "library", label: "LIB", title: "Saved snapshots and comparisons" },
  { kind: "tips", label: "TIPS", title: "Keeping freed space free" },
];

interface MainWindowProps {
  view: UnitView;
  controls: UnitControls;
  connected: boolean | null;
  backendStatus: BackendStatus | null;
  onRetry: () => void;
  snapshotCount: number;
  windowCount: number;
  openKinds: Set<Kind>;
  onToggle: (kind: Kind) => void;
  onNewScan: () => void;
  onNewCompare: () => void;
  onArrange: () => void;
  skin: Skin;
  onSkin: (skin: Skin) => void;
}

export function MainWindow({
  view,
  controls,
  connected,
  backendStatus,
  onRetry,
  snapshotCount,
  windowCount,
  openKinds,
  onToggle,
  onNewScan,
  onNewCompare,
  onArrange,
  skin,
  onSkin,
}: MainWindowProps) {
  const [free, setFree] = useState<{ bytes: number; low: boolean } | null>(null);

  // Free space on the main disk, re-read now and then.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const read = () =>
      getSpaceTips()
        .then((t) => !cancelled && setFree({ bytes: t.freeBytes, low: t.lowSpace }))
        .catch(() => {});
    read();
    const timer = setInterval(read, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connected]);

  // Outside Electron there's no supervisor to ask, so a failed health check
  // is all there is to go on.
  const failed = connected !== true && (backendStatus ? backendStatus.state === "error" : connected === false);
  const state = connected === true ? "READY" : failed ? "OFFLINE" : "STARTING";
  const marquee = [
    "DISK INTELLIGENCE",
    connected === true ? "BACKEND READY" : failed ? backendStatus?.detail || "BACKEND UNAVAILABLE" : backendStatus?.detail || "STARTING BACKEND",
    free ? `${formatBytes(free.bytes)} FREE${free.low ? " · RUNNING LOW" : ""}` : null,
    `${snapshotCount} SNAPSHOT${snapshotCount === 1 ? "" : "S"}`,
    `${windowCount} WINDOW${windowCount === 1 ? "" : "S"}`,
    "READ-ONLY ANALYSIS",
  ]
    .filter(Boolean)
    .join("  ★  ")
    .toUpperCase();

  return (
    <Window title="DISK INTELLIGENCE" shadeInfo={`${state} · ${free ? formatBytes(free.bytes) + " free" : ""}`} view={view} controls={controls} className="kind-main" closable={false}>
      <div className="hub">
        <div className="lcd hub-lcd">
          <div className="hub-lcd-top">
            <span className={`led ${connected === true ? "" : failed ? "is-bad" : "is-busy"}`} data-on />
            <span className="hub-state">{state}</span>
            <span className="spacer" />
            <span className={`hub-free ${free?.low ? "lcd-bad" : ""}`}>{free ? formatBytes(free.bytes) : "--.- GB"}</span>
            <span className="lcd-dim">FREE</span>
          </div>
          <div className="marquee" aria-label={marquee}>
            <div className="marquee-track" aria-hidden>
              <span>{marquee}  ★  </span>
              <span>{marquee}  ★  </span>
            </div>
          </div>
        </div>

        {failed ? <BackendStatusPanel status={backendStatus} connected={connected} onRetry={onRetry} /> : null}

        <div className="hub-buttons" hidden={failed}>
          <button type="button" className="steel-btn is-big" onClick={onNewScan} title="Scan a folder in a new window">
            SCAN
          </button>
          <button type="button" className="steel-btn is-big" onClick={onNewCompare} title="Compare two folders in a pair of windows">
            COMPARE
          </button>
          {TOGGLES.map((t) => (
            <button
              key={t.kind}
              type="button"
              className={`steel-btn is-toggle ${openKinds.has(t.kind) ? "is-on" : ""}`}
              onClick={() => onToggle(t.kind)}
              title={t.title}
              aria-pressed={openKinds.has(t.kind)}
            >
              <span className="btn-led" />
              {t.label}
            </button>
          ))}
        </div>

        <div className="hub-foot">
          <label className="hub-skin">
            SKIN
            <select value={skin} onChange={(e) => onSkin(e.target.value as Skin)} aria-label="Skin">
              {SKINS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <button type="button" className="chip" onClick={onArrange} title="Re-pack every window around the centre">
            ARRANGE
          </button>
        </div>
      </div>
    </Window>
  );
}
