import { useState, useEffect, useMemo } from "react";
import {
  getFindings,
  getExtensionSummary,
  healthCheck,
  saveSnapshot,
  getSnapshots,
  updateSnapshot,
  deleteSnapshot,
} from "./api";
import type {
  Finding,
  ScanResponse,
  ExtensionSummary as ExtSummaryType,
  Snapshot,
} from "./api";
import { ScanControls } from "./components/ScanControls";
import type { ScanStatus } from './components/ScanControls';
import { ScanResults } from "./components/ScanResults";
import { SnapshotGallery } from "./components/SnapshotGallery";
import "./App.css";

type TabId = "findings" | "extensions";
type Theme = "light" | "dark";

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
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [currentSnapshot, setCurrentSnapshot] = useState<Snapshot | null>(null);
  const [isSavingSnapshot, setIsSavingSnapshot] = useState(false);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(theme === "light" ? "dark" : "light");
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

  // Handle selecting a snapshot from the gallery
  const handleSelectSnapshot = (snapshot: Snapshot) => {
    console.log("Selecting snapshot:", snapshot);
    setCurrentSnapshot(snapshot);
    setFindings(snapshot.findings);
    setExtensions(snapshot.extensions);
    setScanInfo(snapshot.scanInfo);
    setScanId(snapshot.scanId);
    setActiveTab("findings");
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
          <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>
            {theme === "light" ? "Dark" : "Light"}
          </button>
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

        {!scanId && scanStatus === "idle" && (
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
