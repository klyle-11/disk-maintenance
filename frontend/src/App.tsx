import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { deleteSnapshot, getSnapshots, healthCheck, setApiBaseUrl, type ComparisonSnapshot } from "./api";
import type { BackendStatus as BackendStatusType } from "./electron.d";
import { Cluster, type UnitControls, type UnitView } from "./wm/Cluster";
import { KINDS, initialState, newUnit, saveState, wmReducer, type Kind, type Unit } from "./wm/state";
import { readSkin, saveSkin, type Skin } from "./skins";
import { MainWindow } from "./windows/MainWindow";
import { LibraryWindow } from "./windows/LibraryWindow";
import { ScanWindow } from "./windows/ScanWindow";
import { ComparePair } from "./windows/ComparePair";
import { DhmWindow, DiWindow, TipsWindow } from "./windows/ToolWindows";
import "./wm/wm.css";
import "./App.css";

/** First launch: the hub in the middle, the two CLIs and the library around it. */
const DEFAULT_UNITS: Unit[] = [
  newUnit("main", "main"),
  newUnit("dhm", "dhm"),
  newUnit("di", "di"),
  newUnit("library", "library"),
];

function initialView() {
  return { w: window.innerWidth, h: Math.max(0, window.innerHeight - 30) };
}

function App() {
  const [skin, setSkin] = useState<Skin>(readSkin);

  // Connection state
  const [connected, setConnected] = useState<boolean | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatusType | null>(null);

  // Snapshot library
  const [snapshots, setSnapshots] = useState<ComparisonSnapshot[]>([]);
  const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(true);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});

  const [wm, dispatch] = useReducer(wmReducer, undefined, () => initialState(DEFAULT_UNITS, initialView()));
  const counterRef = useRef(0);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", skin);
    saveSkin(skin);
  }, [skin]);

  // Tag the document with the host platform so CSS can reserve space for
  // the macOS traffic lights only when needed.
  useEffect(() => {
    const platform = window.electronAPI?.platform;
    if (platform) {
      document.documentElement.setAttribute("data-platform", platform);
    }
  }, []);

  // Remember the arrangement, a moment after it stops changing.
  useEffect(() => {
    const timer = setTimeout(() => saveState(wm), 400);
    return () => clearTimeout(timer);
  }, [wm]);

  // Follow the backend supervisor in the main process. It knows the port the
  // backend actually landed on, which is not always 8001, and why it failed
  // when it did.
  useEffect(() => {
    let cancelled = false;

    const apply = (status: BackendStatusType | null) => {
      if (cancelled || !status) return;
      setBackendStatus(status);
      if (status.baseUrl) {
        try {
          setApiBaseUrl(status.baseUrl);
        } catch (err) {
          console.error("[Backend] refused base URL:", err);
        }
      }
      // 'ready' means the supervisor's own health probe passed; the renderer
      // still confirms for itself below.
      if (status.state !== "ready") setConnected(false);
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
        .then(() => {
          if (cancelled) return;
          setConnected(true);
          timer = setTimeout(check, 15000);
        })
        .catch(() => {
          if (cancelled) return;
          setConnected(false);
          timer = setTimeout(check, 2000);
        });
    };
    check();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [backendStatus?.baseUrl]);

  const handleRetryBackend = async () => {
    setConnected(null);
    const status = await window.electronAPI?.retryBackend();
    if (status) setBackendStatus(status);
  };

  const loadSnapshots = useCallback(() => {
    let cancelled = false;
    getSnapshots()
      .then((loaded) => {
        if (cancelled) return;
        console.log(`[Snapshots] Loaded ${loaded.length} snapshots`);
        setSnapshots(loaded);
        setSnapshotsError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[Snapshots] Failed to load snapshots:", err);
        setSnapshotsError(err instanceof Error ? err.message : "Failed to load snapshots");
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSnapshots(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load snapshots once the backend is actually reachable. Firing this on
  // mount raced the backend: the request went out before we knew which port
  // the backend had landed on, failed, and was never retried.
  useEffect(() => {
    if (!connected) return;
    return loadSnapshots();
  }, [connected, loadSnapshots]);

  const retrySnapshots = () => {
    setIsLoadingSnapshots(true);
    setSnapshotsError(null);
    loadSnapshots();
  };

  // ---------------------------------------------------------------------
  // Opening and closing windows
  // ---------------------------------------------------------------------

  const nextId = (kind: Kind) => `${kind}-${++counterRef.current}`;
  const isOpen = (kind: Kind) => wm.units.some((u) => u.kind === kind);

  const toggleWindow = (kind: Kind) => {
    if (isOpen(kind)) dispatch({ type: "close", id: kind });
    else dispatch({ type: "open", unit: newUnit(kind, kind) });
  };

  const openSnapshot = (snapshot: ComparisonSnapshot) => {
    const existing = wm.units.find((u) => u.snapshotId === snapshot.id);
    if (existing) {
      dispatch({ type: "focus", id: existing.id });
      return;
    }
    const kind: Kind = snapshot.snapshotType === "comparison" ? "compare" : "scan";
    dispatch({ type: "open", unit: newUnit(kind, nextId(kind), { snapshotId: snapshot.id }) });
  };

  const handleDeleteSnapshot = async (snapshot: ComparisonSnapshot) => {
    try {
      await deleteSnapshot(snapshot.id);
      setSnapshots((prev) => prev.filter((s) => s.id !== snapshot.id));
      setProblems((prev) => {
        const next = { ...prev };
        delete next[snapshot.id];
        return next;
      });
      // A window showing a deleted snapshot has nothing left to show.
      for (const u of wm.units) if (u.snapshotId === snapshot.id) dispatch({ type: "close", id: u.id });
    } catch (err) {
      console.error("Failed to delete snapshot:", err);
      window.alert("Failed to delete snapshot. Please try again.");
    }
  };

  const snapshotSaved = (unitId: string) => (snapshot: ComparisonSnapshot) => {
    setSnapshots((prev) => [snapshot, ...prev.filter((s) => s.id !== snapshot.id)]);
    dispatch({ type: "patch", id: unitId, patch: { snapshotId: snapshot.id } });
  };

  const snapshotUpdated = (snapshot: ComparisonSnapshot) =>
    setSnapshots((prev) => prev.map((s) => (s.id === snapshot.id ? snapshot : s)));

  const snapshotProblem = (id: string, problem: string | null) =>
    setProblems((prev) => {
      if ((prev[id] ?? null) === problem) return prev;
      const next = { ...prev };
      if (problem) next[id] = problem;
      else delete next[id];
      return next;
    });

  const openKinds = new Set(wm.units.map((u) => u.kind));
  const openSnapshotIds = new Set(wm.units.map((u) => u.snapshotId).filter((id): id is string => !!id));
  const ready = connected === true;

  const renderUnit = (view: UnitView, controls: UnitControls) => {
    const { unit } = view;
    const snapshot = unit.snapshotId ? snapshots.find((s) => s.id === unit.snapshotId) ?? null : null;
    switch (unit.kind) {
      case "main":
        return (
          <MainWindow
            view={view}
            controls={controls}
            connected={connected}
            backendStatus={backendStatus}
            onRetry={handleRetryBackend}
            snapshotCount={snapshots.length}
            windowCount={wm.units.reduce((n, u) => n + KINDS[u.kind].members, 0)}
            openKinds={openKinds}
            onToggle={toggleWindow}
            onNewScan={() => dispatch({ type: "open", unit: newUnit("scan", nextId("scan")) })}
            onNewCompare={() => dispatch({ type: "open", unit: newUnit("compare", nextId("compare")) })}
            onArrange={() => dispatch({ type: "arrange" })}
            skin={skin}
            onSkin={setSkin}
          />
        );
      case "dhm":
        return <DhmWindow view={view} controls={controls} connected={ready} />;
      case "di":
        return <DiWindow view={view} controls={controls} connected={ready} />;
      case "tips":
        return <TipsWindow view={view} controls={controls} connected={ready} />;
      case "library":
        return (
          <LibraryWindow
            view={view}
            controls={controls}
            snapshots={snapshots}
            loading={isLoadingSnapshots && !snapshotsError}
            error={snapshotsError}
            problems={problems}
            openIds={openSnapshotIds}
            onOpen={openSnapshot}
            onDelete={handleDeleteSnapshot}
            onRetry={retrySnapshots}
          />
        );
      case "scan":
        return (
          <ScanWindow
            view={view}
            controls={controls}
            snapshot={snapshot}
            connected={ready}
            onSaved={snapshotSaved(unit.id)}
            onUpdated={snapshotUpdated}
            onProblem={snapshotProblem}
          />
        );
      case "compare":
        return (
          <ComparePair
            view={view}
            controls={controls}
            snapshot={snapshot}
            connected={ready}
            onSaved={snapshotSaved(unit.id)}
            onUpdated={snapshotUpdated}
            onProblem={snapshotProblem}
          />
        );
    }
  };

  return (
    <div className="app">
      <div className="desk-bar">
        <span className="desk-bar-logo">DISK INTELLIGENCE</span>
      </div>
      <Cluster state={wm} dispatch={dispatch} renderUnit={renderUnit} />
    </div>
  );
}

export default App;
