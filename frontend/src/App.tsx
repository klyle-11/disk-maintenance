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
import "./App.css";

type TabId = "findings" | "extensions";
type Theme = "light" | "dark" | "sepia";

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
      try {
        const loadedSnapshots = await getSnapshots();
        setSnapshots(loadedSnapshots);
      } catch (err) {
        console.error("Failed to load snapshots:", err);
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
        comparisonResult.summary,
        comparisonResult.tree
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
    if (!comparisonSnapshotId || !comparisonResult) return;

    setIsSavingSnapshot(true);
    try {
      const updated = await updateComparisonSnapshot(
        comparisonSnapshotId,
        comparisonResult.summary,
        comparisonResult.tree
      );

      // Update the snapshot in the list
      setSnapshots(snapshots.map(s => s.id === updated.id ? updated : s));
      alert("Comparison updated successfully!");
    } catch (err) {
      console.error("Failed to update comparison snapshot:", err);
      alert("Failed to update comparison. Please try again.");
    } finally {
      setIsSavingSnapshot(false);
    }
  };

  // Handle selecting a snapshot from the gallery
  const handleSelectSnapshot = (snapshot: ComparisonSnapshot) => {
    console.log("Selecting snapshot:", snapshot);

    // Check if this is a comparison snapshot
    if (snapshot.snapshotType === "comparison" && snapshot.comparisonTree) {
      // Load comparison snapshot
      setComparisonResult({
        sourcePath: snapshot.rootPath,
        targetPath: snapshot.targetPath || "",
        summary: snapshot.comparisonSummary || {
          identical: 0,
          modified: 0,
          missingFromTarget: 0,
          extraInTarget: 0,
        },
        tree: snapshot.comparisonTree,
      });
      setComparisonSnapshotId(snapshot.id);
      setScanId(null);
      setCurrentSnapshot(null);
      setFindings([]);
      setExtensions([]);
    } else {
      // Load regular scan snapshot
      setCurrentSnapshot(snapshot);
      setFindings(snapshot.findings || []);
      setExtensions(snapshot.extensions || []);
      setScanInfo(snapshot.scanInfo);
      setScanId(snapshot.scanId);
      setActiveTab("findings");
      setComparisonResult(null);
      setComparisonSnapshotId(null);
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
        )}

        {comparisonResult && (
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
        )}

        {!scanId && !comparisonResult && scanStatus === "idle" && (
          <>
            <div className="welcome-message">
              <h2>Welcome to Disk Intelligence</h2>
              <p>
                Analyze your disk to find large files, duplicates, cache folders,
                and other disk usage insights.
              </p>
              <ol>
                <li>Select a directory to scan</li>
                <li>Click "Scan & Analyze" to start</li>
                <li>Review findings and understand your disk usage</li>
              </ol>
            </div>

            <SnapshotGallery
              snapshots={snapshots}
              onSelectSnapshot={handleSelectSnapshot}
              onDeleteSnapshot={handleDeleteSnapshot}
            />
          </>
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
