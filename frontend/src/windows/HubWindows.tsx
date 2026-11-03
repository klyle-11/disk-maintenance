/**
 * The small windows that run the app: status, controls, skins, and the
 * backend window that appears when the backend can't start.
 */
import { API_VERSION, formatBytes, getApiBaseUrl } from "../api";
import { BackendStatus } from "../components/BackendStatus";
import { SKINS } from "../skins";
import { appStore, backendFailed, loadTips, retryBackend, setPanel, setSkin, useApp } from "../state/app";
import { newCompare } from "../state/compare";
import { newScan } from "../state/scan";
import { useStore } from "../store";
import type { UnitControls, UnitView } from "../wm/Cluster";
import { closeWindow, KINDS, openWindow, wmDispatch, wmStore } from "../wm/state";
import { Window } from "../wm/Window";

export interface WindowArgs {
  view: UnitView;
  controls: UnitControls;
}

export function StatusWindow({ view, controls }: WindowArgs) {
  const connected = useApp((s) => s.connected);
  const failed = useApp(backendFailed);
  const detail = useApp((s) => s.backend?.detail ?? "");
  const free = useApp((s) => s.tips?.freeBytes ?? null);
  const low = useApp((s) => s.tips?.lowSpace ?? false);
  const snapshots = useApp((s) => s.snapshots.length);
  const windows = useStore(wmStore, (s) => s.units.reduce((n, u) => n + KINDS[u.kind].members, 0));
  const electron = window.electronAPI;

  const state = connected === true ? "READY" : failed ? "OFFLINE" : "STARTING";
  const marquee = [
    "DISK INTELLIGENCE",
    connected === true ? "BACKEND READY" : detail || (failed ? "BACKEND UNAVAILABLE" : "STARTING BACKEND"),
    free != null ? `${formatBytes(free)} FREE${low ? " · RUNNING LOW" : ""}` : null,
    `${snapshots} SNAPSHOT${snapshots === 1 ? "" : "S"}`,
    `${windows} WINDOWS`,
  ]
    .filter(Boolean)
    .join("  ★  ")
    .toUpperCase();

  return (
    <Window
      title="DISK INTELLIGENCE"
      shadeInfo={`${state}${free != null ? ` · ${formatBytes(free)} free` : ""}`}
      view={view}
      controls={controls}
      className="kind-status"
      closable={!!electron}
      closeLabel="Quit"
      onClose={() => electron?.quit()}
      onMinimize={electron ? () => electron.minimize() : undefined}
    >
      <div className="lcd status">
        <div className="status-top">
          <span className={`led ${connected === true ? "" : failed ? "is-bad" : "is-busy"}`} data-on />
          <span className="status-state">{state}</span>
          <span className="spacer" />
          <span className={`status-free ${low ? "lcd-bad" : ""}`}>{free != null ? formatBytes(free) : "--.- GB"}</span>
          <span className="lcd-dim">FREE</span>
        </div>
        <div className="marquee" aria-label={marquee}>
          <div className="marquee-track" aria-hidden>
            <span>{marquee}  ★  </span>
            <span>{marquee}  ★  </span>
          </div>
        </div>
      </div>
    </Window>
  );
}

/** Open the tips that apply here, each in its own window; or close them all. */
async function toggleTips(): Promise<void> {
  const open = wmStore.get().units.filter((u) => u.kind === "tip");
  if (open.length) {
    open.forEach((u) => closeWindow(u.id));
    return;
  }
  const tips = appStore.get().tips ?? (await loadTips());
  if (!tips) return;
  const relevant = tips.tips.filter((t) => t.relevant);
  for (const tip of relevant.length ? relevant : tips.tips) openWindow("tip", `tip:${tip.id}`, { ref: tip.id });
}

/** A tool and the windows that come with it open and close together. */
function toggleTool(id: "dhm" | "di" | "library" | "skins"): void {
  if (wmStore.get().units.some((u) => u.id === id)) {
    closeWindow(id);
    return;
  }
  openWindow(id);
  if (id === "dhm") openWindow("dhm-out", "dhm-out", { parent: "dhm" });
  if (id === "di") openWindow("di-cmds", "di-cmds", { parent: "di" });
}

export function ControlsWindow({ view, controls }: WindowArgs) {
  const open = useStore(wmStore, (s) => s.units.map((u) => u.kind).join(" "));
  const kinds = new Set(open.split(" "));
  const ready = useApp((s) => s.connected === true);

  const toggle = (label: string, on: boolean, onClick: () => void, title: string) => (
    <button
      type="button"
      className={`steel-btn is-toggle ${on ? "is-on" : ""}`}
      onClick={onClick}
      title={title}
      aria-pressed={on}
    >
      <span className="btn-led" />
      {label}
    </button>
  );

  return (
    <Window title="CONTROLS" view={view} controls={controls} className="kind-controls" closable={false}>
      <div className="controls">
        <button type="button" className="steel-btn is-primary" onClick={newScan} disabled={!ready} title="Scan a folder">
          SCAN
        </button>
        <button type="button" className="steel-btn is-primary" onClick={newCompare} disabled={!ready} title="Compare two folders">
          COMPARE
        </button>
        {toggle("DHM", kinds.has("dhm"), () => toggleTool("dhm"), "du-hast-much: folder sizes, CLI style")}
        {toggle("DI", kinds.has("di"), () => toggleTool("di"), "di: the Disk Intelligence command line")}
        {toggle("LIB", kinds.has("library"), () => toggleTool("library"), "Saved snapshots and comparisons")}
        {toggle("TIPS", kinds.has("tip"), () => void toggleTips(), "Each space-saving tip in its own window")}
        {toggle("SKINS", kinds.has("skins"), () => toggleTool("skins"), "Colour themes")}
        <button type="button" className="steel-btn" onClick={() => wmDispatch({ type: "arrange" })} title="Re-pack every window around the centre">
          ARRANGE
        </button>
      </div>
    </Window>
  );
}

export function SkinsWindow({ view, controls }: WindowArgs) {
  const current = useApp((s) => s.skin);
  const panels = useApp((s) => s.panels);
  const info = SKINS.find((s) => s.id === current);
  return (
    <Window
      title="SKINS"
      shadeInfo={`${info?.label} · ${panels[current] === "dark" ? "dark" : "white"} inside`}
      view={view}
      controls={controls}
      className="kind-skins"
    >
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
            {window.electronAPI ? (
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
