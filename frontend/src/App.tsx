import { useState, useEffect, useMemo } from "react";
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
} from "./api";
import type {
  Finding,
  ScanResponse,
  ExtensionSummary as ExtSummaryType,
  Snapshot,
  ComparisonResponse,
  ComparisonSnapshot,
} from "./api";
import { ScanControls } from "./components/ScanControls";
import type { ScanStatus } from './components/ScanControls';
import { ScanResults } from "./components/ScanResults";
import { SnapshotGallery } from "./components/SnapshotGallery";
import { ComparisonResults } from "./components/ComparisonResults";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./App.css";

type TabId = "findings" | "extensions";
type Theme = "light" | "dark" | "sepia" | "dark-sepia";

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

  // Comparison state
  const [comparisonResult, setComparisonResult] = useState<ComparisonResponse | null>(null);
  const [comparisonSnapshotId, setComparisonSnapshotId] = useState<string | null>(null);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const handleThemeChange = (newTheme: Theme) => {
    setTheme(newTheme);
  };

  // Check backend health on mount
  useEffect(() => {
    healthCheck()
      .then(() => setConnected(true))
      .catch(() => setConnected(false));
  }, []);

  // Load snapshots on mount
  useEffect(() => {
    const loadSnapshots = async () => {
      setIsLoadingSnapshots(true);
      setSnapshotsError(null);
      try {
        const loadedSnapshots = await getSnapshots();
        setSnapshots(loadedSnapshots);
      } catch (err) {
        console.error("Failed to load snapshots:", err);
        setSnapshotsError(err instanceof Error ? err.message : "Failed to load snapshots");
      } finally {
        setIsLoadingSnapshots(false);
      }
    };
    loadSnapshots();
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
    setCurrentSnapshot(null); // Clear snapshot mode when new scan completes
    setComparisonResult(null); // Clear comparison when new scan starts
    setComparisonSnapshotId(null);
  };

  // Handle comparison completion
  const handleComparisonComplete = (result: ComparisonResponse) => {
    setComparisonResult(result);
    setComparisonSnapshotId(null);
    setScanId(null); // Clear scan results when showing comparison
    setCurrentSnapshot(null);
  };

  // Handle saving a snapshot
  const handleSaveSnapshot = async () => {
    if (!scanId || !scanInfo) return;

    setIsSavingSnapshot(true);
    try {
      const snapshot = await saveSnapshot(scanId, scanInfo.rootPath);
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

      // Update current data
      setFindings(updated.findings);
      setExtensions(updated.extensions);
      setScanInfo(updated.scanInfo);
      setScanId(updated.scanId);
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
    console.log("Selecting snapshot:", snapshot);

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
      if (snapshot.snapshotType === "comparison") {
        updatedSnapshot = await updateComparisonSnapshot(snapshot.id);
      } else {
        const updated = await updateSnapshot(snapshot.id);
        // Convert Snapshot to ComparisonSnapshot for consistent handling
        updatedSnapshot = { ...updated, snapshotType: "scan" as const };
      }

      // Update the snapshot in the list with fresh data
      setSnapshots(snapshots.map(s => s.id === updatedSnapshot.id ? updatedSnapshot : s));

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
      } else {
        // Load regular scan snapshot with updated data
        setCurrentSnapshot(updatedSnapshot);
        setFindings(updatedSnapshot.findings || []);
        setExtensions(updatedSnapshot.extensions || []);
        setScanInfo(updatedSnapshot.scanInfo);
        setScanId(updatedSnapshot.scanId);
        setActiveTab("findings");
        setComparisonResult(null);
        setComparisonSnapshotId(null);
      }
    } catch (err) {
      console.error("Failed to update snapshot on load:", err);
      // If auto-update fails, still load the original snapshot data
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
      } else {
        setCurrentSnapshot(snapshot);
        setFindings(snapshot.findings || []);
        setExtensions(snapshot.extensions || []);
        setScanInfo(snapshot.scanInfo);
        setScanId(snapshot.scanId);
        setActiveTab("findings");
        setComparisonResult(null);
        setComparisonSnapshotId(null);
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

      // If we're viewing this snapshot, clear the view
      if (currentSnapshot?.id === snapshotId) {
        setCurrentSnapshot(null);
        setScanId(null);
        setFindings([]);
        setExtensions([]);
        setScanInfo(null);
      }

      // If we're viewing this comparison snapshot, clear the comparison view
      if (comparisonSnapshotId === snapshotId) {
        setComparisonResult(null);
        setComparisonSnapshotId(null);
      }

      alert("Snapshot deleted successfully!");
    } catch (err) {
      console.error("Failed to delete snapshot:", err);
      alert("Failed to delete snapshot. Please try again.");
    }
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
        <h1>Disk Intelligence</h1>
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
      </header>

      <main className="app-main">
        <ScanControls
          onScanComplete={handleScanComplete}
          onComparisonComplete={handleComparisonComplete}
          status={scanStatus}
          setStatus={setScanStatus}
          scanInfo={scanInfo}
        />

        {scanId && scanInfo && (
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
              scanId={scanId}
              rootPath={scanInfo.rootPath}
              isSnapshot={currentSnapshot !== null}
              snapshotId={currentSnapshot?.id}
              onSaveSnapshot={handleSaveSnapshot}
              onUpdateSnapshot={handleUpdateSnapshot}
              isSaving={isSavingSnapshot}
            />
          </ErrorBoundary>
        )}

        {comparisonResult && (
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
        )}

        {!scanId && !comparisonResult && scanStatus === "idle" && (
          <div className="home-container">
            <div className="welcome-message">
                <h2>Welcome to Disk Intelligence</h2>
                <p className="welcome-subtitle">
                  Discover disk usage patterns, identify space hogs, and reclaim valuable storage
                </p>
                <p><strong>Read-Only & Safe:</strong> Disk Intelligence only analyzes your files without modifying them. Your data stays secure.</p>
            </div>

            <SnapshotGallery
              snapshots={snapshots}
              onSelectSnapshot={handleSelectSnapshot}
              onDeleteSnapshot={handleDeleteSnapshot}
              isLoading={isLoadingSnapshots}
              isUpdating={isSavingSnapshot}
              error={snapshotsError}
              onRetry={() => {
                setIsLoadingSnapshots(true);
                setSnapshotsError(null);
                getSnapshots()
                  .then(setSnapshots)
                  .catch((err) => setSnapshotsError(err instanceof Error ? err.message : "Failed to load"))
                  .finally(() => setIsLoadingSnapshots(false));
              }}
            />
          </div>
        )}
      </main>

      <footer className="app-footer">
        <p>Disk Intelligence - Read-only disk analysis tool</p>
      </footer>
    </div>
  );
}

export default App;

// TODO: Add treemap visualization
// TODO: Add timeline of disk changes
// TODO: Add rule engine UI for custom detection
// TODO: Add cloud storage integration
// TODO: Add real-time scan progress with WebSocket
