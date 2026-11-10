/**
 * The tray's mini panel: free space on the home disk, a one-line di check run
 * each time the panel opens, and a button for each of the main window's
 * tools. A button brings the main window up with that tool open.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "../api";
import { desktop, isTauri } from "../desktop";
import { readPanels, readSkin } from "../skins";
import type { TrayTool } from "../state/fromTray";
import { summaryLine, type DiSummary, type SummaryLine } from "./summary";

interface Disk {
  name: string;
  mount: string;
  total_bytes: number;
  free_bytes: number;
  home: boolean;
}

type Check = { state: "running" } | { state: "done"; line: SummaryLine } | { state: "failed"; error: string };

/** Below this share free a disk shows as running low (as in the hub). */
const LOW_SHARE = 0.1;

function applySkin() {
  const skin = readSkin();
  document.documentElement.setAttribute("data-theme", skin);
  document.documentElement.setAttribute("data-panel", readPanels()[skin]);
}

const TOOLS: { tool: TrayTool; label: string; title: string }[] = [
  { tool: "scan", label: "SCAN", title: "Scan a folder" },
  { tool: "compare", label: "COMPARE", title: "Compare two folders" },
  { tool: "offload", label: "OFFLOAD", title: "Move folders to an external drive, verified" },
  { tool: "dhm", label: "DHM", title: "du-hast-much: folder sizes, CLI style" },
  { tool: "di", label: "DI", title: "di: the Disk Intelligence command line" },
  { tool: "tips", label: "TIPS", title: "Ways to keep freed space free" },
];

export function TrayPanel() {
  const [disk, setDisk] = useState<Disk | null>(null);
  const [check, setCheck] = useState<Check>({ state: "running" });
  const [cachesOk, setCachesOk] = useState(false);

  // The quick check: free space at once (native), then di's summary.
  const refresh = useCallback(() => {
    if (!isTauri) return;
    invoke<Disk[]>("disks")
      .then((disks) => setDisk(disks.find((d) => d.home) ?? disks[0] ?? null))
      .catch(() => {});
    setCheck({ state: "running" });
    invoke<DiSummary>("tray_summary")
      .then((s) => setCheck({ state: "done", line: summaryLine(s) }))
      .catch((e) => setCheck({ state: "failed", error: String(e) }));
  }, []);

  useEffect(() => {
    applySkin();
    refresh();
    // The main window saves skin changes; follow them.
    const onStorage = () => applySkin();
    window.addEventListener("storage", onStorage);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void invoke("tray_hide").catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    if (isTauri) {
      invoke<{ supported: boolean; targets: unknown[] }>("cache_targets")
        .then((r) => setCachesOk(r.supported && r.targets.length > 0))
        .catch(() => {});
    }
    const off = isTauri ? listen("tray://shown", () => {
      applySkin();
      refresh();
    }) : null;
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("keydown", onKey);
      void off?.then((f) => f());
    };
  }, [refresh]);

  const open = (tool: TrayTool | null) => void invoke("tray_open", { tool }).catch(() => {});

  const used = disk && disk.total_bytes > 0 ? 1 - disk.free_bytes / disk.total_bytes : 0;
  const low = !!disk && disk.total_bytes > 0 && disk.free_bytes / disk.total_bytes < LOW_SHARE;

  return (
    <section className="wm-window tray-panel is-active" aria-label="Disk Intelligence">
      <header className="wm-titlebar tray-titlebar">
        <span className="wm-grooves" aria-hidden />
        <span className="wm-title">DISK INTELLIGENCE</span>
        <span className="wm-grooves" aria-hidden />
        <span className="wm-buttons">
          <button
            type="button"
            className="wm-btn wm-btn-close"
            onClick={() => void invoke("tray_hide").catch(() => {})}
            aria-label="Close"
            title="Close"
          />
        </span>
      </header>
      <div className="wm-body tray-body">
        <button type="button" className="lcd tray-lcd" onClick={refresh} title="Check again">
          <div className="disk-row is-home">
            <span className="disk-name" title={disk?.mount}>{disk ? disk.name : "HOME"}</span>
            <span className="disk-bar" aria-hidden>
              <span className={low ? "is-low" : ""} style={{ width: `${Math.round(used * 100)}%` }} />
            </span>
            <span className={`disk-free ${low ? "lcd-bad" : "lcd-strong"}`}>{disk ? formatBytes(disk.free_bytes) : "…"}</span>
            <span className="disk-of lcd-dim">{disk ? `/ ${formatBytes(disk.total_bytes)}` : ""}</span>
          </div>
          <div className="tray-line">
            <span
              className={`led ${check.state === "running" ? "is-busy" : check.state === "failed" || check.line.tone === "bad" ? "is-bad" : ""}`}
              data-on
            />
            {check.state === "running" ? (
              <span className="lcd-dim lcd-ellipsis">
                di: checking<span className="blink">…</span>
              </span>
            ) : check.state === "failed" ? (
              <span className="lcd-dim lcd-ellipsis" title={check.error}>
                di: {check.error}
              </span>
            ) : (
              <span
                className={`lcd-ellipsis ${check.line.tone === "bad" ? "lcd-bad" : check.line.tone === "warn" ? "lcd-accent" : ""}`}
                title={check.line.text}
              >
                {check.line.text}
              </span>
            )}
          </div>
        </button>
        <div className="controls tray-controls">
          {TOOLS.map((t) => (
            <button key={t.tool} type="button" className="steel-btn" onClick={() => open(t.tool)} title={t.title}>
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className="steel-btn"
            onClick={() => open("caches")}
            disabled={!cachesOk}
            title={cachesOk ? "Empty the OS's cache folders (asks first)" : "Clearing caches is for macOS and Windows"}
          >
            CACHES
          </button>
          <button type="button" className="steel-btn" onClick={refresh} title="Run the quick check again">
            CHECK
          </button>
          <button type="button" className="steel-btn is-primary tray-wide" onClick={() => open(null)} title="Open the main window">
            OPEN DISK INTELLIGENCE
          </button>
          <button type="button" className="steel-btn" onClick={() => desktop?.quit()} title="Quit Disk Intelligence">
            QUIT
          </button>
        </div>
      </div>
    </section>
  );
}
