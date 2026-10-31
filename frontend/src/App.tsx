import { useEffect } from "react";
import { API_VERSION, healthCheck, setApiBaseUrl } from "./api";
import type { BackendStatus } from "./electron.d";
import { appStore, backendFailed, loadSnapshots, loadTips, patchApp, useApp } from "./state/app";
import { loadDiCommands } from "./state/di";
import { useStore } from "./store";
import { Cluster, type UnitControls, type UnitView } from "./wm/Cluster";
import { closeWindow, openWindow, wmDispatch, wmStore } from "./wm/state";
import { CompareWindow, ComparePairWindows } from "./windows/CompareWindows";
import { DhmOutWindow, DhmWindow } from "./windows/DhmWindows";
import { DiCmdsWindow, DiWindow } from "./windows/DiWindows";
import { BackendWindow, ControlsWindow, SkinsWindow, StatusWindow } from "./windows/HubWindows";
import { LibraryWindow } from "./windows/LibraryWindow";
import { FindingsWindow, ScanWindow, TypesWindow } from "./windows/ScanWindows";
import { TipWindow } from "./windows/TipWindow";
import "./wm/wm.css";

function renderUnit(view: UnitView, controls: UnitControls) {
  const args = { view, controls };
  switch (view.unit.kind) {
    case "status":
      return <StatusWindow {...args} />;
    case "controls":
      return <ControlsWindow {...args} />;
    case "skins":
      return <SkinsWindow {...args} />;
    case "backend":
      return <BackendWindow {...args} />;
    case "library":
      return <LibraryWindow {...args} />;
    case "tip":
      return <TipWindow {...args} />;
    case "dhm":
      return <DhmWindow {...args} />;
    case "dhm-out":
      return <DhmOutWindow {...args} />;
    case "di":
      return <DiWindow {...args} />;
    case "di-cmds":
      return <DiCmdsWindow {...args} />;
    case "scan":
      return <ScanWindow {...args} />;
    case "findings":
      return <FindingsWindow {...args} />;
    case "types":
      return <TypesWindow {...args} />;
    case "compare":
      return <CompareWindow {...args} />;
    case "cmp-pair":
      return <ComparePairWindows {...args} />;
  }
}

function App() {
  const wm = useStore(wmStore, (s) => s);
  const skin = useApp((s) => s.skin);
  const panel = useApp((s) => s.panels[s.skin]);
  const connected = useApp((s) => s.connected);
  const baseUrl = useApp((s) => s.backend?.baseUrl);
  const failed = useApp(backendFailed);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", skin);
    document.documentElement.setAttribute("data-panel", panel);
  }, [skin, panel]);

  // Follow the backend supervisor in the main process. It knows the port the
  // backend actually landed on, which is not always 8001, and why it failed
  // when it did.
  useEffect(() => {
    let cancelled = false;

    const apply = (status: BackendStatus | null) => {
      if (cancelled || !status) return;
      if (status.baseUrl) {
        try {
          setApiBaseUrl(status.baseUrl);
        } catch (err) {
          console.error("[Backend] refused base URL:", err);
        }
      }
      // 'ready' means the supervisor's own health probe passed; the renderer
      // still confirms for itself below.
      patchApp(status.state === "ready" ? { backend: status } : { backend: status, connected: false });
    };

    window.electronAPI?.getBackendStatus().then(apply).catch(() => {});
    const unsubscribe = window.electronAPI?.onBackendStatus(apply);

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  // Confirm the backend answers us directly, and keep retrying while it does
  // not. Backs off once connected so an idle app is not polling constantly.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const check = () => {
      healthCheck()
        .then((health) => {
          if (cancelled) return;
          // An older backend answers here too, then 404s on newer endpoints:
          // refuse it rather than half-work against it.
          const api = health.api ?? 0;
          if (api !== API_VERSION) {
            if (appStore.get().outdated !== api) patchApp({ connected: false, outdated: api });
            timer = setTimeout(check, 5000);
            return;
          }
          const { connected, outdated } = appStore.get();
          if (connected !== true || outdated !== null) patchApp({ connected: true, outdated: null });
          timer = setTimeout(check, 15000);
        })
        .catch(() => {
          if (cancelled) return;
          if (appStore.get().connected !== false) patchApp({ connected: false });
          timer = setTimeout(check, 2000);
        });
    };
    check();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [baseUrl]);

  // Load the library, tips and di's commands once the backend is reachable.
  // Firing these on mount raced the backend: the requests went out before we
  // knew which port it had landed on, failed, and were never retried.
  useEffect(() => {
    if (!connected) return;
    void loadSnapshots();
    void loadDiCommands();
    void loadTips();
    // Free space (shown in the status window) comes with the tips.
    const timer = setInterval(() => void loadTips(), 60_000);
    return () => clearInterval(timer);
  }, [connected]);

  // When the backend can't start, say so in a window of its own.
  useEffect(() => {
    if (failed) openWindow("backend");
    else closeWindow("backend");
  }, [failed]);

  return <Cluster state={wm} dispatch={wmDispatch} renderUnit={renderUnit} />;
}

export default App;
