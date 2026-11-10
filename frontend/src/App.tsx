import { useEffect } from "react";
import { API_VERSION, healthCheck, setApiBaseUrl } from "./api";
import type { BackendStatus } from "./electron.d";
import { appStore, backendFailed, loadDisks, loadSnapshots, loadTips, patchApp, useApp } from "./state/app";
import { loadDiCommands } from "./state/di";
import { useStore } from "./store";
import { Cluster, type UnitControls, type UnitView } from "./wm/Cluster";
import { closeWindow, openWindow, wmDispatch, wmStore } from "./wm/state";
import { CompareWindow } from "./windows/CompareWindows";
import { DhmWindow } from "./windows/DhmWindows";
import { DiWindow } from "./windows/DiWindows";
import { BackendWindow, HubWindow } from "./windows/HubWindows";
import { OffloadWindow } from "./windows/OffloadWindow";
import { ScanWindow } from "./windows/ScanWindows";
import { TipsWindow } from "./windows/TipsWindow";
import { desktop } from "./desktop";
import "./wm/wm.css";

function renderUnit(view: UnitView, controls: UnitControls) {
  const args = { view, controls };
  switch (view.unit.kind) {
    case "hub":
      return <HubWindow {...args} />;
    case "backend":
      return <BackendWindow {...args} />;
    case "dhm":
      return <DhmWindow {...args} />;
    case "di":
      return <DiWindow {...args} />;
    case "tips":
      return <TipsWindow {...args} />;
    case "scan":
      return <ScanWindow {...args} />;
    case "compare":
      return <CompareWindow {...args} />;
    case "offload":
      return <OffloadWindow {...args} />;
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

  // Electron: follow the backend supervisor in the main process. It knows the
  // port the backend actually landed on, which is not always 8001, and why it
  // failed when it did. (In Tauri the backend is part of the app.)
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

    desktop?.getBackendStatus?.().then(apply).catch(() => {});
    const unsubscribe = desktop?.onBackendStatus?.(apply);

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
    void loadDisks();
    // Free space (shown in the hub) comes with the tips and the disk list.
    const timer = setInterval(() => {
      void loadTips();
      void loadDisks();
    }, 60_000);
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
