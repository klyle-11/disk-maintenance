/**
 * The hub, the main window: status and free space on every disk, the controls
 * that open each tool, and the skins. Dragging it moves every window. Plus the
 * backend window that appears when the (Electron) backend can't start.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { API_VERSION, formatBytes, getApiBaseUrl, type DiskSpace } from "../api";
import { BackendStatus } from "../components/BackendStatus";
import { desktop } from "../desktop";
import { SKINS } from "../skins";
import { backendFailed, retryBackend, setPanel, setSkin, useApp } from "../state/app";
import { closeCompare, newCompare } from "../state/compare";
import { openOffload } from "../state/offload";
import { closeScan, newScan } from "../state/scan";
import { useStore } from "../store";
import type { UnitControls, UnitView } from "../wm/Cluster";
import { closeWindow, openWindow, wmDispatch, wmStore, type Kind } from "../wm/state";
import { Window } from "../wm/Window";

export interface WindowArgs {
  view: UnitView;
  controls: UnitControls;
}

/** Below this share free a disk shows as running low. */
const LOW_SHARE = 0.1;

function DiskRow({ disk, low }: { disk: DiskSpace; low: boolean }) {
  const used = disk.totalBytes > 0 ? 1 - disk.freeBytes / disk.totalBytes : 0;
  return (
    <div
      className={`disk-row ${disk.home ? "is-home" : ""}`}
      title={`${disk.mount}\n${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}`}
    >
      <span className="disk-name">
        {disk.name}
        {disk.removable ? <span className="lcd-dim"> ⏏</span> : null}
      </span>
      <span className="disk-bar" aria-hidden>
        <span className={low ? "is-low" : ""} style={{ width: `${Math.round(used * 100)}%` }} />
      </span>
      <span className={`disk-free ${low ? "lcd-bad" : "lcd-strong"}`}>{formatBytes(disk.freeBytes)}</span>
      <span className="disk-of lcd-dim">/ {formatBytes(disk.totalBytes)}</span>
    </div>
  );
}

function SkinPicker() {
  const current = useApp((s) => s.skin);
  const panels = useApp((s) => s.panels);
  return (
    <div className="skins">
      <div className="skin-grid" role="radiogroup" aria-label="Skin">
        {SKINS.map((skin) => (
          <button
            key={skin.id}
            type="button"
            role="radio"
            aria-checked={skin.id === current}
            className={`skin-swatch ${skin.id === current ? "is-on" : ""}`}
            onClick={() => setSkin(skin.id)}
            title={skin.label}
          >
            <span className="skin-preview" style={{ background: skin.swatch.frame }}>
              <span style={{ background: panels[skin.id] === "dark" ? skin.swatch.dark : skin.swatch.light }}>
                <span style={{ background: skin.swatch.accent }} />
              </span>
            </span>
            <span className="skin-name">{skin.label}</span>
          </button>
        ))}
      </div>
      <div className="field-row">
        <span className="field">INSIDE</span>
        <div className="seg is-wide" role="radiogroup" aria-label="Inside">
          {(["dark", "light"] as const).map((panel) => (
            <button
              key={panel}
              type="button"
              role="radio"
              aria-checked={panels[current] === panel}
              className={`seg-btn ${panels[current] === panel ? "is-on" : ""}`}
              onClick={() => setPanel(panel)}
            >
              {panel === "dark" ? "DARK" : "WHITE"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Open a tool's window, or close it (asking first if it holds unsaved work). */
function toggleTool(kind: Exclude<Kind, "hub" | "backend">): void {
  const open = wmStore.get().units.some((u) => u.id === kind);
  if (kind === "scan") return open ? void closeScan() : newScan();
  if (kind === "compare") return open ? void closeCompare() : newCompare();
  if (kind === "offload" && !open) return openOffload();
  if (open) closeWindow(kind);
  else openWindow(kind);
}

/**
 * Size a window's height to its content: `inner` is the content at its
 * natural height, `outer` the box it lives in.
 */
function useFitHeight(id: string, shaded: boolean, height: number) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || shaded) return;
    const fit = () => {
      const delta = i.offsetHeight - o.clientHeight;
      if (Math.abs(delta) >= 1) wmDispatch({ type: "fit", id, h: height + delta });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(i);
    return () => observer.disconnect();
  }, [id, shaded, height]);
  return { outer, inner };
}

export function HubWindow({ view, controls }: WindowArgs) {
  const connected = useApp((s) => s.connected);
  const failed = useApp(backendFailed);
  const detail = useApp((s) => s.backend?.detail ?? "");
  const disks = useApp((s) => s.disks);
  const tipsFree = useApp((s) => s.tips?.freeBytes ?? null);
  const low = useApp((s) => s.tips?.lowSpace ?? false);
  const open = useStore(wmStore, (s) => s.units.map((u) => u.kind).join(" "));
  const kinds = new Set(open.split(" "));
  const [skinsOpen, setSkinsOpen] = useState(false);
  const { outer, inner } = useFitHeight(view.unit.id, view.unit.shaded, view.unit.sizes[0].h);

  const state = connected === true ? "READY" : failed ? "OFFLINE" : "STARTING";
  const home = disks.find((d) => d.home);
  const homeFree = home?.freeBytes ?? tipsFree;
  const shown: DiskSpace[] =
    disks.length > 0
      ? disks
      : tipsFree != null
        ? [{ name: "HOME", mount: "~", totalBytes: 0, freeBytes: tipsFree, removable: false, home: true }]
        : [];

  const toggle = (label: string, on: boolean, onClick: () => void, title: string) => (
    <button type="button" className={`steel-btn is-toggle ${on ? "is-on" : ""}`} onClick={onClick} title={title} aria-pressed={on}>
      <span className="btn-led" />
      {label}
    </button>
  );
  const ready = connected === true;

  return (
    <Window
      title="DISK INTELLIGENCE"
      shadeInfo={`${state}${homeFree != null ? ` · ${formatBytes(homeFree)} free` : ""}`}
      view={view}
      controls={controls}
      className="kind-hub"
      anchor
      closable={!!desktop}
      closeLabel="Quit"
      onClose={() => desktop?.quit()}
      onMinimize={desktop ? () => desktop?.minimize() : undefined}
    >
      <div className="hub" ref={outer}>
        <div className="hub-inner" ref={inner}>
          <div className="lcd status">
            <div className="status-top">
              <span className={`led ${ready ? "" : failed ? "is-bad" : "is-busy"}`} data-on />
              <span className="status-state">{state}</span>
              <span className="spacer" />
              {!ready && detail ? <span className="lcd-dim lcd-ellipsis">{detail}</span> : null}
              {ready ? <span className="lcd-dim">FREE SPACE</span> : null}
            </div>
            {shown.map((d) => (
              <DiskRow
                key={d.mount}
                disk={d}
                low={(d.home && low) || (d.totalBytes > 0 && d.freeBytes / d.totalBytes < LOW_SHARE)}
              />
            ))}
            {ready && shown.length === 0 ? <div className="lcd-dim">reading disks…</div> : null}
          </div>
          <div className="controls">
            {toggle("SCAN", kinds.has("scan"), () => toggleTool("scan"), "Scan a folder; saved scans are in its library")}
            {toggle("COMPARE", kinds.has("compare"), () => toggleTool("compare"), "Compare two folders")}
            {toggle("OFFLOAD", kinds.has("offload"), () => toggleTool("offload"), "Move folders to an external drive, verified, and keep track of them")}
            {toggle("DHM", kinds.has("dhm"), () => toggleTool("dhm"), "du-hast-much: folder sizes, CLI style")}
            {toggle("DI", kinds.has("di"), () => toggleTool("di"), "di: the Disk Intelligence command line")}
            {toggle("TIPS", kinds.has("tips"), () => toggleTool("tips"), "Ways to keep freed space free")}
            {toggle("SKINS", skinsOpen, () => setSkinsOpen((v) => !v), "Colour themes")}
            <button type="button" className="steel-btn" onClick={() => wmDispatch({ type: "arrange" })} title="Re-pack every window">
              ARRANGE
            </button>
            <button type="button" className="steel-btn" onClick={controls.resetPan} title="Move the windows back to the middle of the screen">
              CENTRE
            </button>
          </div>
          {skinsOpen ? <SkinPicker /> : null}
        </div>
      </div>
    </Window>
  );
}

export function BackendWindow({ view, controls }: WindowArgs) {
  const backend = useApp((s) => s.backend);
  const connected = useApp((s) => s.connected);
  const outdated = useApp((s) => s.outdated);
  return (
    <Window
      title="BACKEND"
      shadeInfo={outdated !== null ? "out of date" : "unavailable"}
      view={view}
      controls={controls}
      className="kind-backend"
    >
      <div className="backend-win">
        {outdated !== null ? (
          <div className="lcd backend-outdated">
            <div className="lcd-bad">BACKEND OUT OF DATE</div>
            <p>
              The backend at {getApiBaseUrl()} speaks API {outdated}; this app needs {API_VERSION}. It is missing newer
              endpoints (di, tips), so the app won't use it.
            </p>
            <p>
              If an older Disk Intelligence (or a <code>python backend/main.py</code> from an older checkout) is still
              running, quit it. If this app was packaged with an old backend build, run{" "}
              <code>scripts/build-backend.sh</code> and package again.
            </p>
            {backend?.state === "error" && backend.detail ? <p className="lcd-dim">{backend.detail}</p> : null}
            {desktop?.retryBackend ? (
              <button type="button" className="chip" onClick={() => void retryBackend()}>
                RETRY
              </button>
            ) : null}
          </div>
        ) : (
          <BackendStatus status={backend} connected={connected} onRetry={retryBackend} />
        )}
      </div>
    </Window>
  );
}
