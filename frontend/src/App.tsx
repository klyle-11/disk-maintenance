import { useState, useEffect, useMemo } from "react";
import {
  getFindings,
  getExtensionSummary,
  healthCheck,
} from "./api";
import type {
  Finding,
  ScanResponse,
  ExtensionSummary as ExtSummaryType,
} from "./api";
import { ScanControls, ScanStatus } from "./components/ScanControls";
import { FiltersBar } from "./components/FiltersBar";
import { FindingsTable } from "./components/FindingsTable";
import { ActionBar } from "./components/ActionBar";
import { ExtensionSummary } from "./components/ExtensionSummary";
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
  const [selectedRisk, setSelectedRisk] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
    setSelectedIds(new Set());
  };

  // Handle action completion (refresh findings)
  const handleActionComplete = async () => {
    if (!scanId) return;
    setSelectedIds(new Set());
    // Re-fetch findings after action
    try {
      const findingsData = await getFindings(scanId);
      setFindings(findingsData);
    } catch (err) {
      console.error("Failed to refresh findings:", err);
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
      // Risk filter
      if (selectedRisk !== "all" && f.riskLevel !== selectedRisk) {
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
  }, [findings, selectedCategory, selectedRisk, searchQuery]);

  // Get selected findings
  const selectedFindings = useMemo(() => {
    return filteredFindings.filter((f) => selectedIds.has(f.id));
  }, [filteredFindings, selectedIds]);

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

        {scanId && (
          <>
            <div className="tabs">
              <button
                className={`tab ${activeTab === "findings" ? "active" : ""}`}
                onClick={() => setActiveTab("findings")}
              >
                Findings ({findings.length})
              </button>
              <button
                className={`tab ${activeTab === "extensions" ? "active" : ""}`}
                onClick={() => setActiveTab("extensions")}
              >
                File Types ({extensions.length})
              </button>
            </div>

            {activeTab === "findings" && (
              <>
                <FiltersBar
                  categories={categories}
                  selectedCategory={selectedCategory}
                  setSelectedCategory={setSelectedCategory}
                  selectedRisk={selectedRisk}
                  setSelectedRisk={setSelectedRisk}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                />

                <ActionBar
                  selectedFindings={selectedFindings}
                  onActionComplete={handleActionComplete}
                />

                {loading ? (
                  <div className="loading">Loading findings...</div>
                ) : (
                  <FindingsTable
                    findings={filteredFindings}
                    selectedIds={selectedIds}
                    onSelectionChange={setSelectedIds}
                  />
                )}
              </>
            )}

            {activeTab === "extensions" && (
              <ExtensionSummary extensions={extensions} />
            )}
          </>
        )}

        {!scanId && scanStatus === "idle" && (
          <div className="welcome-message">
            <h2>Welcome to Disk Intelligence</h2>
            <p>
              Analyze your disk to find large files, duplicates, cache folders,
              and other opportunities to reclaim space.
            </p>
            <ol>
              <li>Enter a path to scan (e.g., C:\Users\YourName)</li>
              <li>Click "Scan & Analyze" to start</li>
              <li>Review findings and take action</li>
            </ol>
            <p className="safety-note">
              <strong>Safety first:</strong> All operations require explicit
              confirmation. Nothing is deleted automatically.
            </p>
          </div>
        )}
      </main>

      <footer className="app-footer">
        <p>Disk Intelligence MVP - Use with caution when deleting files</p>
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
