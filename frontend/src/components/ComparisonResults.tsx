import { useState } from "react";
import type { ComparisonItem, ComparisonSummary } from "../api";
import { formatBytes } from "../api";
import "./ComparisonResults.css";

type StatusFilter = "all" | "identical" | "modified" | "missing_from_target" | "extra_in_target";

interface ComparisonResultsProps {
  sourcePath: string;
  targetPath: string;
  summary: ComparisonSummary;
  tree: ComparisonItem[];
  isSnapshot: boolean;
  onSaveSnapshot: () => void;
  onUpdateSnapshot: () => void;
  isSaving: boolean;
}

export function ComparisonResults({
  sourcePath,
  targetPath,
  summary,
  tree,
  isSnapshot,
  onSaveSnapshot,
  onUpdateSnapshot,
  isSaving,
}: ComparisonResultsProps) {
  const [showAll, setShowAll] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    // Initially expand only top level folders
    const expanded = new Set<string>();
    const expandFirstLevel = (items: ComparisonItem[], path = "", depth = 0) => {
      for (const item of items) {
        const itemPath = path ? `${path}/${item.name}` : item.name;
        // Expand only folders at depth 0 (top level)
        if (item.itemType === "folder" && depth === 0) {
          expanded.add(itemPath);
        }
        if (item.children) {
          expandFirstLevel(item.children, itemPath, depth + 1);
        }
      }
    };
    expandFirstLevel(tree);
    return expanded;
  });

  const toggleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const collapseAll = () => {
    setExpandedPaths(new Set());
  };

  const expandAll = () => {
    const expanded = new Set<string>();
    const collectAllFolders = (items: ComparisonItem[], path = "") => {
      for (const item of items) {
        const itemPath = path ? `${path}/${item.name}` : item.name;
        if (item.itemType === "folder") {
          expanded.add(itemPath);
        }
        if (item.children) {
          collectAllFolders(item.children, itemPath);
        }
      }
    };
    collectAllFolders(tree);
    setExpandedPaths(expanded);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "identical":
        return <span className="status-icon identical">=</span>;
      case "modified":
        return <span className="status-icon modified">≠</span>;
      case "missing_from_target":
        return <span className="status-icon missing">+</span>;
      case "extra_in_target":
        return <span className="status-icon extra">−</span>;
      default:
        return null;
    }
  };

  const getStatusLabel = (item: ComparisonItem) => {
    if (item.status === "modified" && item.sourceModified && item.targetModified) {
      const sourceDate = new Date(item.sourceModified);
      const targetDate = new Date(item.targetModified);
      if (sourceDate > targetDate) {
        return "Newer in source";
      } else if (targetDate > sourceDate) {
        return "Newer in target";
      }
      return "Size differs";
    }
    switch (item.status) {
      case "identical":
        return "Identical";
      case "modified":
        return "Modified";
      case "missing_from_target":
        return "Missing from target";
      case "extra_in_target":
        return "Only in target";
      default:
        return item.status;
    }
  };

  const renderItem = (item: ComparisonItem, path: string, depth: number) => {
    const itemPath = path ? `${path}/${item.name}` : item.name;
    const isExpanded = expandedPaths.has(itemPath);
    const isFolder = item.itemType === "folder";
    const hasDifferences = item.differenceCount > 0 || item.status !== "identical";

    // Filter based on selected status
    const shouldShow = statusFilter === "all" || item.status === statusFilter;

    if (!shouldShow) {
      return null;
    }

    // Check if all children are filtered out (for folders)
    const hasVisibleChildren = isFolder && item.children
      ? item.children.some(child => {
          return statusFilter === "all" || child.status === statusFilter;
        })
      : true;

    if (isFolder && !hasVisibleChildren && statusFilter !== "all") {
      return null;
    }

    return (
      <div key={itemPath} className="comparison-item" style={{ marginLeft: depth * 20 }}>
        <div
          className={`item-row ${item.status} ${isFolder ? "folder" : "file"}`}
          onClick={() => isFolder && toggleExpand(itemPath)}
        >
          {isFolder && (
            <span className={`expand-icon ${isExpanded ? "expanded" : ""}`}>
              ▶
            </span>
          )}
          <span className="item-icon">{isFolder ? "📁" : "📄"}</span>
          <span className="item-name">{item.name}</span>
          {isFolder && item.differenceCount > 0 && (
            <span className="difference-badge">
              {item.differenceCount} difference{item.differenceCount !== 1 ? "s" : ""}
            </span>
          )}
          {!isFolder && (
            <span className="item-status">{getStatusLabel(item)}</span>
          )}
          {getStatusIcon(item.status)}
        </div>

        {!isFolder && hasDifferences && (
          <div className="item-details">
            {item.sourceSize !== null && (
              <div className="detail-row">
                <span className="detail-label">Source:</span>
                <span>{formatBytes(item.sourceSize)}</span>
                {item.sourceModified && (
                  <span className="detail-date">
                    {new Date(item.sourceModified).toLocaleString()}
                  </span>
                )}
              </div>
            )}
            {item.targetSize !== null && (
              <div className="detail-row">
                <span className="detail-label">Target:</span>
                <span>{formatBytes(item.targetSize)}</span>
                {item.targetModified && (
                  <span className="detail-date">
                    {new Date(item.targetModified).toLocaleString()}
                  </span>
                )}
              </div>
            )}
            {item.sourceSize === null && (
              <div className="detail-row only-target">
                <span className="detail-label">Only in target:</span>
                <span>{formatBytes(item.targetSize || 0)}</span>
              </div>
            )}
            {item.targetSize === null && (
              <div className="detail-row only-source">
                <span className="detail-label">Only in source:</span>
                <span>{formatBytes(item.sourceSize || 0)}</span>
              </div>
            )}
          </div>
        )}

        {isFolder && isExpanded && item.children && (
          <div className="item-children">
            {item.children.map((child) => renderItem(child, itemPath, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const totalDifferences =
    summary.modified + summary.missingFromTarget + summary.extraInTarget;

  return (
    <div className="comparison-results">
      <div className="comparison-header">
        <div className="comparison-paths">
          <span className="path-label">Source:</span>
          <span className="path-value">{sourcePath}</span>
          <span className="path-separator">↔</span>
          <span className="path-label">Target:</span>
          <span className="path-value">{targetPath}</span>
        </div>
        <div className="header-actions">
          {statusFilter !== "all" && (
            <button
              className="filter-badge"
              onClick={() => setStatusFilter("all")}
            >
              Filter: {statusFilter === "identical" ? "Identical" : statusFilter === "modified" ? "Modified" : statusFilter === "missing_from_target" ? "Missing" : "Extra"} ✕
            </button>
          )}
          <button
            className="snapshot-action-btn"
            onClick={isSnapshot ? onUpdateSnapshot : onSaveSnapshot}
            disabled={isSaving}
          >
            {isSaving
              ? "Saving..."
              : isSnapshot
              ? "Update Comparison"
              : "Save Comparison"}
          </button>
        </div>
      </div>

      {statusFilter !== "all" && (
        <div className="filter-active-message">
          Showing {summary.identical} identical, {summary.modified} modified, {summary.missingFromTarget} missing, and {summary.extraInTarget} extra items
        </div>
      )}

      <div className="comparison-summary">
        <div
          className={`summary-item identical ${statusFilter === "all" || statusFilter === "identical" ? "active" : ""}`}
          onClick={() => statusFilter === "identical" ? setStatusFilter("all") : setStatusFilter("identical")}
        >
          <span className="summary-count">{summary.identical}</span>
          <span className="summary-label">Identical</span>
        </div>
        <div
          className={`summary-item modified ${statusFilter === "all" || statusFilter === "modified" ? "active" : ""}`}
          onClick={() => statusFilter === "modified" ? setStatusFilter("all") : setStatusFilter("modified")}
        >
          <span className="summary-count">{summary.modified}</span>
          <span className="summary-label">Modified</span>
        </div>
        <div
          className={`summary-item missing ${statusFilter === "all" || statusFilter === "missing_from_target" ? "active" : ""}`}
          onClick={() => statusFilter === "missing_from_target" ? setStatusFilter("all") : setStatusFilter("missing_from_target")}
        >
          <span className="summary-count">{summary.missingFromTarget}</span>
          <span className="summary-label">Missing</span>
        </div>
        <div
          className={`summary-item extra ${statusFilter === "all" || statusFilter === "extra_in_target" ? "active" : ""}`}
          onClick={() => statusFilter === "extra_in_target" ? setStatusFilter("all") : setStatusFilter("extra_in_target")}
        >
          <span className="summary-count">{summary.extraInTarget}</span>
          <span className="summary-label">Extra</span>
        </div>
      </div>

      {statusFilter === "all" && (
        <div className="comparison-controls-bar">
          <div className="view-toggles">
            <button
              className={`view-toggle ${!showAll ? "active" : ""}`}
              onClick={() => setShowAll(false)}
            >
              Differences only ({totalDifferences})
            </button>
            <button
              className={`view-toggle ${showAll ? "active" : ""}`}
              onClick={() => setShowAll(true)}
            >
              Show all
            </button>
          </div>
          <div className="expand-collapse-buttons">
            <button className="expand-collapse-btn" onClick={collapseAll}>
              Collapse All
            </button>
            <button className="expand-collapse-btn" onClick={expandAll}>
              Expand All
            </button>
          </div>
        </div>
      )}

      <div className="comparison-tree">
        {tree.map((item) => renderItem(item, "", 0))}
        {statusFilter !== "all" && (
          <div className="filter-active-message">
            Showing {summary.identical} identical, {summary.modified} modified, {summary.missingFromTarget} missing, and {summary.extraInTarget} extra items
          </div>
        )}
        {statusFilter === "all" && !showAll && totalDifferences === 0 && (
          <div className="no-differences">
            All files are identical! The folders match perfectly.
          </div>
        )}
        {statusFilter === "all" && !showAll && totalDifferences > 0 && (
          <div className="filtered-message">
            Showing {totalDifferences} items with differences only
          </div>
        )}
      </div>

      {statusFilter !== "all" && (
        <div className="no-filtered-items">
          <span className="empty-icon">📭</span>
          <h3>No Items Match Filter</h3>
          <p>Try selecting a different status filter to view items.</p>
        </div>
      )}
    </div>
  );
}
