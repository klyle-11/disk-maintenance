import { useState, useEffect, useMemo } from "react";
import { ScanControls } from "./components/ScanControls";
import type { ScanStatus } from './components/ScanControls';
import { ScanResults } from "./components/ScanResults";
import { SnapshotGallery } from "./components/SnapshotGallery";
import { ComparisonResults } from "./components/ComparisonResults";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SnapshotSidebar } from "./components/SnapshotSidebar";
import { DuHastMuch } from "./components/DuHastMuch";
import {
  getFindings,
  getExtensionSummary,
  healthCheck,
  saveSnapshot,
  getSnapshots,
  updateSnapshot,
  deleteSnapshot,
  saveComparisonSnapshot,
  updateComparisonSnapshot,
  getDuHastMuchHistory,
  type Finding,
  type ScanResponse,
  type ExtensionSummary as ExtSummaryType,
  type ComparisonResponse,
  type ComparisonSnapshot,
} from "./api";
import "./App.css";

type TabId = "findings" | "extensions";
type Theme = "light" | "dark" | "sepia" | "dark-sepia";
type MainView = "du-hast-much" | "scan-results" | "comparison";

function App() {
  // Theme state
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("theme") as Theme;
    return saved || "light";
  });

  // Connection state
  const [connected, setConnected] = useState<boolean | null>(null);

  // Scan state
  const [scanId, setScanId] = useState<string | null>(null);
  const [scanInfo, setScanInfo] = useState<ScanResponse | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus>("idle");

  // Data state
  const [findings, setFindings] = useState<Finding[]>([]);
  const [extensions, setExtensions] = useState<ExtSummaryType[]>([]);
  const [loading, setLoading] = useState(false);

  // UI state
  const [activeTab, setActiveTab] = useState<TabId>("findings");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Snapshot state
  const [snapshots, setSnapshots] = useState<ComparisonSnapshot[]>([]);
  const [currentSnapshot, setCurrentSnapshot] = useState<ComparisonSnapshot | null>(null);
  const [isSavingSnapshot, setIsSavingSnapshot] = useState(false);
  const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(true);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [snapshotErrors, setSnapshotErrors] = useState<Record<string, string>>({});

  // Comparison state
  const [comparisonResult, setComparisonResult] = useState<ComparisonResponse | null>(null);
  const [comparisonSnapshotId, setComparisonSnapshotId] = useState<string | null>(null);

  // Du-hast-much state
  const [mainView, setMainView] = useState<MainView>("du-hast-much");
  const [latestDuHastMuch, setLatestDuHastMuch] = useState<any | null>(null);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
  };

  // Check backend health on mount, retry until connected
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const check = () => {
      healthCheck()
        .then(() => {
          if (!cancelled) setConnected(true);
        })
        .catch(() => {
          if (!cancelled) {
            setConnected(false);
            timer = setTimeout(check, 3000);
          }
        });
    };
    check();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Load snapshots on mount
  useEffect(() => {
    const loadSnapshots = async () => {
      setIsLoadingSnapshots(true);
      setSnapshotsError(null);
      console.log("[Snapshots] Loading saved snapshots...");
      try {
        const loadedSnapshots = await getSnapshots();
        console.log(`[Snapshots] Loaded ${loadedSnapshots.length} snapshots`);
        setSnapshots(loadedSnapshots);
      } catch (err) {
        console.error("[Snapshots] Failed to load snapshots:", err);
        setSnapshotsError(err instanceof Error ? err.message : "Failed to load snapshots");
      } finally {
        setIsLoadingSnapshots(false);
      }
    };
    loadSnapshots();
  }, []);

  // Load latest du-hast-much scan on mount
  useEffect(() => {
    const loadLatestDuHastMuch = () => {
      try {
        const history = getDuHastMuchHistory();
        if (history.length > 0) {
          setLatestDuHastMuch(history[0]); // Most recent is first
          console.log("[DuHastMuch] Loaded latest scan from history");
        }
      } catch (err) {
        console.error("[DuHastMuch] Failed to load history:", err);
      }
    };
    loadLatestDuHastMuch();
  }, []);

  // Fetch findings when scan completes
  useEffect(() => {
    if (!scanId) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        const [findingsData, extensionsData] = await Promise.all([
          getFindings(scanId),
          getExtensionSummary(scanId),
        ]);
        setFindings(findingsData);
        setExtensions(extensionsData);
      } catch (err) {
        console.error("Failed to fetch data:", err);
      }
      setLoading(false);
    };

    fetchData();
  }, [scanId]);

  // Handle scan completion
  const handleScanComplete = (newScanId: string, info: ScanResponse) => {
    setScanId(newScanId);
    setScanInfo(info);
    setMainView("scan-results"); // Switch to scan results view
    setCurrentSnapshot(null); // Clear snapshot mode when new scan completes
    setComparisonResult(null); // Clear comparison when new scan starts
    setComparisonSnapshotId(null);
  };

  // Handle comparison completion
  const handleComparisonComplete = (result: ComparisonResponse) => {
    setComparisonResult(result);
    setMainView("comparison"); // Switch to comparison view
    setComparisonSnapshotId(null);
    setScanId(null); // Clear scan results when showing comparison
    setCurrentSnapshot(null);
  };

  // Handle saving a snapshot
  const handleSaveSnapshot = async () => {
    if (!scanId || !scanInfo) return;

    setIsSavingSnapshot(true);
    try {
      const snapshot = await saveSnapshot(scanId, scanInfo.rootPath, scanInfo);
      setSnapshots([snapshot, ...snapshots]);
      setCurrentSnapshot(snapshot);
      alert("Snapshot saved successfully!");
    } catch (err) {
      console.error("Failed to save snapshot:", err);
      alert("Failed to save snapshot. Please try again.");
    } finally {
      setIsSavingSnapshot(false);
    }
  };

  // Handle updating a snapshot
  const handleUpdateSnapshot = async () => {
    if (!currentSnapshot) return;

    setIsSavingSnapshot(true);
    try {
      const updated = await updateSnapshot(currentSnapshot.id);

      // Update the snapshot in the list
      setSnapshots(snapshots.map(s => s.id === updated.id ? updated : s));

      // Update current data directly from the snapshot - don't set scanId to prevent API fetch
      setFindings(updated.findings);
      setExtensions(updated.extensions);
      setScanInfo(updated.scanInfo);
      setScanId(null); // Clear scanId to prevent unnecessary API fetch
      setCurrentSnapshot(updated);

      alert("Snapshot updated successfully!");
    } catch (err) {
      console.error("Failed to update snapshot:", err);
      alert("Failed to update snapshot. Please try again.");
    } finally {
      setIsSavingSnapshot(false);
    }
  };

  // Handle saving a comparison snapshot
  const handleSaveComparisonSnapshot = async () => {
    if (!comparisonResult) return;

    setIsSavingSnapshot(true);
    try {
      const snapshot = await saveComparisonSnapshot(
        comparisonResult.sourcePath,
        comparisonResult.targetPath,
        comparisonResult.comparisonId
      );
      setSnapshots([snapshot, ...snapshots]);
      setComparisonSnapshotId(snapshot.id);
      alert("Comparison saved successfully!");
    } catch (err) {
      console.error("Failed to save comparison snapshot:", err);
      alert("Failed to save comparison. Please try again.");
    } finally {
      setIsSavingSnapshot(false);
    }
  };

  // Handle updating a comparison snapshot
  const handleUpdateComparisonSnapshot = async () => {
    if (!comparisonSnapshotId) return;

    setIsSavingSnapshot(true);
    try {
      const updated = await updateComparisonSnapshot(comparisonSnapshotId);

      // Update the snapshot in the list
      setSnapshots(snapshots.map(s => s.id === updated.id ? updated : s));

      // Update the current comparison result with fresh data
      if (updated.comparison && updated.comparisonSummary) {
        setComparisonResult({
          comparisonId: updated.scanId,
          sourcePath: updated.rootPath,
          targetPath: updated.targetPath || "",
          summary: updated.comparisonSummary,
          tree: updated.comparison,
          deepScan: false,
          completedAt: updated.savedAt,
        });
      }

      alert("Comparison updated successfully!");
    } catch (err) {
      console.error("Failed to update comparison snapshot:", err);
      alert("Failed to update comparison. Please try again.");
    } finally {
      setIsSavingSnapshot(false);
    }
  };

  // Handle selecting a snapshot from the gallery
  const handleSelectSnapshot = async (snapshot: ComparisonSnapshot) => {
    console.log("[Snapshot] Selecting snapshot:", snapshot.id, snapshot.snapshotType);

    // Clear any existing error for this snapshot
    setSnapshotErrors(prev => {
      const newErrors = { ...prev };
      delete newErrors[snapshot.id];
      return newErrors;
    });

    // Check if there's an unsaved current scan
    const hasUnsavedScan = scanId && !currentSnapshot;

    if (hasUnsavedScan) {
      const confirmed = confirm(
        "You have an unsaved scan. Navigating away will cause this scan data to be lost. Are you sure you want to continue?"
      );
      if (!confirmed) {
        return;
      }
    }

    setIsSavingSnapshot(true);
    try {
      let updatedSnapshot: ComparisonSnapshot = snapshot;

      // Auto-update the snapshot when loading to get fresh data
      console.log("[Snapshot] Auto-updating snapshot data...");
      if (snapshot.snapshotType === "comparison") {
        updatedSnapshot = await updateComparisonSnapshot(snapshot.id);
      } else {
        const updated = await updateSnapshot(snapshot.id);
        // Convert Snapshot to ComparisonSnapshot for consistent handling
        updatedSnapshot = { ...updated, snapshotType: "scan" as const };
      }
      console.log("[Snapshot] Auto-update succeeded");

      // Update the snapshot in the list with fresh data
      setSnapshots(snapshots.map(s => s.id === updatedSnapshot.id ? updatedSnapshot : s));

      // Clear error for this snapshot on successful update
      setSnapshotErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[snapshot.id];
        return newErrors;
      });

      // Check if this is a comparison snapshot
      if (updatedSnapshot.snapshotType === "comparison" && updatedSnapshot.comparison) {
        // Load comparison snapshot with updated data
        setComparisonResult({
          comparisonId: updatedSnapshot.scanId,
          sourcePath: updatedSnapshot.rootPath,
          targetPath: updatedSnapshot.targetPath || "",
          summary: updatedSnapshot.comparisonSummary || {
            identical: 0,
            modified: 0,
            missingFromTarget: 0,
            extraInTarget: 0,
            totalSourceSize: 0,
            totalTargetSize: 0,
          },
          tree: updatedSnapshot.comparison,
          deepScan: false,
          completedAt: updatedSnapshot.savedAt,
        });
        setComparisonSnapshotId(updatedSnapshot.id);
        setScanId(null);
        setCurrentSnapshot(null);
        setFindings([]);
        setExtensions([]);
        setScanInfo(null);
        setMainView("comparison"); // Switch to comparison view
      } else {
        // Load regular scan snapshot with updated data
        // Don't set scanId - we already have the data from the snapshot update response
        // Setting scanId would trigger an unnecessary API fetch that will fail (404)
        setCurrentSnapshot(updatedSnapshot);
        setFindings(updatedSnapshot.findings || []);
        setExtensions(updatedSnapshot.extensions || []);
        setScanInfo(updatedSnapshot.scanInfo);
        setScanId(null); // Clear scanId to prevent API fetch - we already have the data
        setActiveTab("findings");
        setComparisonResult(null);
        setComparisonSnapshotId(null);
        setMainView("scan-results"); // Switch to scan results view
      }
    } catch (err) {
      console.error("[Snapshot] Failed to update snapshot on load:", err);

      // Parse error message to detect path/drive issues
      const errorMessage = err instanceof Error ? err.message : String(err);
      let userFriendlyError = null;

      if (errorMessage.includes("no longer exists") || errorMessage.includes("not found")) {
        // Extract drive letter if present (e.g., "E:\\Music" -> "E:")
        const driveMatch = errorMessage.match(/([A-Z]):\\/i);
        if (driveMatch) {
          const drive = driveMatch[1];
          userFriendlyError = `Drive ${drive}: is not currently connected`;
        } else {
          userFriendlyError = "Path not found - drive may be disconnected";
        }
      }

      // Store error for this snapshot if we found a specific issue
      if (userFriendlyError) {
        setSnapshotErrors(prev => ({
          ...prev,
          [snapshot.id]: userFriendlyError
        }));
      }

      // If auto-update fails, still load the original snapshot data
      console.warn("[Snapshot] Falling back to cached snapshot data");
      if (snapshot.snapshotType === "comparison" && snapshot.comparison) {
        setComparisonResult({
          comparisonId: snapshot.scanId,
          sourcePath: snapshot.rootPath,
          targetPath: snapshot.targetPath || "",
          summary: snapshot.comparisonSummary || {
            identical: 0,
            modified: 0,
            missingFromTarget: 0,
            extraInTarget: 0,
            totalSourceSize: 0,
            totalTargetSize: 0,
          },
          tree: snapshot.comparison,
          deepScan: false,
          completedAt: snapshot.savedAt,
        });
        setComparisonSnapshotId(snapshot.id);
        setScanId(null);
        setCurrentSnapshot(null);
        setFindings([]);
        setExtensions([]);
        setScanInfo(null);
        setMainView("comparison"); // Switch to comparison view
      } else {
        // Load from cached snapshot data - don't set scanId to prevent API fetch
        setCurrentSnapshot(snapshot);
        setFindings(snapshot.findings || []);
        setExtensions(snapshot.extensions || []);
        setScanInfo(snapshot.scanInfo);
        setScanId(null); // Clear scanId to prevent API fetch - we already have the data
        setActiveTab("findings");
        setComparisonResult(null);
        setComparisonSnapshotId(null);
        setMainView("scan-results"); // Switch to scan results view
      }
    } finally {
      setIsSavingSnapshot(false);
    }
  };

  // Handle deleting a snapshot
  const handleDeleteSnapshot = async (snapshotId: string) => {
    try {
      await deleteSnapshot(snapshotId);
      setSnapshots(snapshots.filter(s => s.id !== snapshotId));

      // Clear error for this snapshot
      setSnapshotErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[snapshotId];
        return newErrors;
      });

      // If we're viewing this snapshot, clear the view
      if (currentSnapshot?.id === snapshotId) {
        setCurrentSnapshot(null);
        setScanId(null);
        setFindings([]);
        setExtensions([]);
        setScanInfo(null);
        setMainView("du-hast-much"); // Return to du-hast-much view
      }

      // If we're viewing this comparison snapshot, clear the comparison view
      if (comparisonSnapshotId === snapshotId) {
        setComparisonResult(null);
        setComparisonSnapshotId(null);
        setMainView("du-hast-much"); // Return to du-hast-much view
      }

      alert("Snapshot deleted successfully!");
    } catch (err) {
      console.error("Failed to delete snapshot:", err);
      alert("Failed to delete snapshot. Please try again.");
    }
  };

  // Handle du-hast-much scan completion
  const handleDuHastMuchComplete = (result: any) => {
    setLatestDuHastMuch(result);
    console.log("[DuHastMuch] Scan completed and saved to history");
  };

  // Navigate back to du-hast-much view
  const handleNavigateToDuHastMuch = () => {
    setMainView("du-hast-much");
    setScanId(null);
    setComparisonResult(null);
    setCurrentSnapshot(null);
    setComparisonSnapshotId(null);
  };

  // Get unique categories from findings
  const categories = useMemo(() => {
    const cats = new Set(findings.map((f) => f.category));
    return Array.from(cats).sort();
  }, [findings]);

  // Filter findings
  const filteredFindings = useMemo(() => {
    return findings.filter((f) => {
      // Category filter
      if (selectedCategory !== "all" && f.category !== selectedCategory) {
        return false;
      }
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesPath = f.paths.some((p) =>
          p.toLowerCase().includes(query)
        );
        const matchesReason = f.reason.toLowerCase().includes(query);
        if (!matchesPath && !matchesReason) {
          return false;
        }
      }
      return true;
    });
  }, [findings, selectedCategory, searchQuery]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <h1
            className="app-title"
            onClick={() => {
              setMainView("du-hast-much");
              setScanId(null);
              setComparisonResult(null);
              setCurrentSnapshot(null);
              setComparisonSnapshotId(null);
            }}
            style={{ cursor: "pointer" }}
          >
            Disk Intelligence
          </h1>
          <div className="header-right">
          <select
            className="theme-select"
            value={theme}
            onChange={(e) => handleThemeChange(e.target.value as Theme)}
            title="Select theme"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="sepia">Sepia</option>
            <option value="dark-sepia">Dark Sepia</option>
          </select>
          <div className="connection-status">
            {connected === null && <span className="status checking">Checking...</span>}
            {connected === true && <span className="status connected">Connected</span>}
            {connected === false && <span className="status disconnected">Disconnected</span>}
          </div>
        </div>
        </div>
      </header>

      <main className="app-main">
        <div className="content-container">
        {/* Single ScanControls instance - never unmounts during scan */}
        <ScanControls
          onScanComplete={handleScanComplete}
          onComparisonComplete={handleComparisonComplete}
          status={scanStatus}
          setStatus={setScanStatus}
          scanInfo={scanInfo}
          onNavigateBack={scanStatus === "idle" ? undefined : handleNavigateToDuHastMuch}
        />

        {/* Du-hast-much view */}
        {mainView === "du-hast-much" && scanStatus === "idle" && (
          <>
            <SnapshotGallery
              snapshots={snapshots}
              onSelectSnapshot={handleSelectSnapshot}
              onDeleteSnapshot={handleDeleteSnapshot}
              isLoading={isLoadingSnapshots}
              isUpdating={isSavingSnapshot}
              error={snapshotsError}
              snapshotErrors={snapshotErrors}
              onRetry={() => {
                setIsLoadingSnapshots(true);
                setSnapshotsError(null);
                getSnapshots()
                  .then(setSnapshots)
                  .catch((err) => setSnapshotsError(err instanceof Error ? err.message : "Failed to load"))
                  .finally(() => setIsLoadingSnapshots(false));
              }}
            />

            <DuHastMuch
              onScanComplete={handleDuHastMuchComplete}
              initialResult={latestDuHastMuch}
            />
          </>
        )}

        {/* Scan results view */}
        {(mainView === "scan-results" || scanStatus !== "idle") && (
          <>

            {(scanId || currentSnapshot) && scanInfo && (
              <ErrorBoundary>
                <ScanResults
                  activeTab={activeTab}
                  setActiveTab={setActiveTab}
                  findings={findings}
                  extensions={extensions}
                  categories={categories}
                  selectedCategory={selectedCategory}
                  setSelectedCategory={setSelectedCategory}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  loading={loading}
                  filteredFindings={filteredFindings}
                  scanId={scanId || currentSnapshot?.id || ""}
                  rootPath={scanInfo.rootPath}
                  isSnapshot={currentSnapshot !== null}
                  snapshotId={currentSnapshot?.id}
                  onSaveSnapshot={handleSaveSnapshot}
                  onUpdateSnapshot={handleUpdateSnapshot}
                  isSaving={isSavingSnapshot}
                />
              </ErrorBoundary>
            )}
          </>
        )}

        {/* Comparison results view */}
        {mainView === "comparison" && comparisonResult && (
          <>
            {(scanStatus !== "idle" || comparisonSnapshotId !== null) && (
              <ScanControls
                onScanComplete={handleScanComplete}
                onComparisonComplete={handleComparisonComplete}
                status={scanStatus}
                setStatus={setScanStatus}
                scanInfo={scanInfo}
                onNavigateBack={handleNavigateToDuHastMuch}
              />
            )}

            <ErrorBoundary>
              <ComparisonResults
                sourcePath={comparisonResult.sourcePath}
                targetPath={comparisonResult.targetPath}
                summary={comparisonResult.summary}
                tree={comparisonResult.tree}
                isSnapshot={comparisonSnapshotId !== null}
                onSaveSnapshot={handleSaveComparisonSnapshot}
                onUpdateSnapshot={handleUpdateComparisonSnapshot}
                isSaving={isSavingSnapshot}
              />
            </ErrorBoundary>
          </>
        )}
        </div>
      </main>

      <footer className="app-footer">
        <p>Disk Intelligence - Read-only disk analysis tool</p>
      </footer>

      {/* Snapshot sidebar - always visible when snapshots exist */}
      {snapshots.length > 0 && (
        <SnapshotSidebar
          snapshots={snapshots}
          currentSnapshotId={currentSnapshot?.id ?? null}
          comparisonSnapshotId={comparisonSnapshotId}
          onSelectSnapshot={handleSelectSnapshot}
        />
      )}
    </div>
  );
}

export default App;

// TODO: Add treemap visualization
// TODO: Add timeline of disk changes
// TODO: Add rule engine UI for custom detection
// TODO: Add cloud storage integration
// TODO: Add real-time scan progress with WebSocket
