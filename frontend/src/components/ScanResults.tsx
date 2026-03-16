import { FiltersBar } from "./FiltersBar";
import { FindingsTable } from "./FindingsTable";
import { ExtensionSummary } from "./ExtensionSummary";
import type { Finding, ExtensionSummary as ExtSummaryType } from "../api";

type TabId = "findings" | "extensions";

interface ScanResultsProps {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  findings: Finding[];
  extensions: ExtSummaryType[];
  categories: string[];
  selectedCategory: string;
  setSelectedCategory: (category: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  loading: boolean;
  filteredFindings: Finding[];
  scanId: string;
  rootPath: string;
  isSnapshot: boolean;
  snapshotId?: string;
  onSaveSnapshot: () => void;
  onUpdateSnapshot: () => void;
  isSaving: boolean;
}

export function ScanResults({
  activeTab,
  setActiveTab,
  findings,
  extensions,
  categories,
  selectedCategory,
  setSelectedCategory,
  searchQuery,
  setSearchQuery,
  loading,
  filteredFindings,
  scanId,
  rootPath,
  isSnapshot,
  snapshotId,
  onSaveSnapshot,
  onUpdateSnapshot,
  isSaving,
}: ScanResultsProps) {
  return (
    <>
      <div className="tabs">
        <div className="tab-buttons">
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
        <button
          className="snapshot-action-btn"
          onClick={isSnapshot ? onUpdateSnapshot : onSaveSnapshot}
          disabled={isSaving}
        >
          {isSaving
            ? "Saving..."
            : isSnapshot
            ? "Update Snapshot"
            : "Save Snapshot"}
        </button>
      </div>

      {activeTab === "findings" && (
        <>
          <FiltersBar
            categories={categories}
            selectedCategory={selectedCategory}
            setSelectedCategory={setSelectedCategory}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
          />

          {loading ? (
            <div className="loading">Loading findings...</div>
          ) : (
            <FindingsTable findings={filteredFindings} />
          )}
        </>
      )}

      {activeTab === "extensions" && (
        <ExtensionSummary extensions={extensions} />
      )}
    </>
  );
}
