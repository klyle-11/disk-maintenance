import { useState } from "react";
import type { ComparisonItem, ComparisonSummary } from "../api";
import { formatBytes } from "../api";
import "./ComparisonResults.css";

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
  const [showAll, setShowAll] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    // Initially expand folders with differences
    const expanded = new Set<string>();
    const findDifferent = (items: ComparisonItem[], path = "") => {
      for (const item of items) {
        const itemPath = path ? `${path}/${item.name}` : item.name;
        if (item.differenceCount > 0 || item.status !== "identical") {
          expanded.add(itemPath);
        }
        if (item.children) {
          findDifferent(item.children, itemPath);
        }
      }
    };
    findDifferent(tree);
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

    // Filter out identical items if not showing all
    if (!showAll && item.status === "identical" && item.differenceCount === 0) {
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

      <div className="comparison-summary">
        <div className="summary-item identical">
          <span className="summary-count">{summary.identical}</span>
          <span className="summary-label">Identical</span>
        </div>
        <div className="summary-item modified">
          <span className="summary-count">{summary.modified}</span>
          <span className="summary-label">Modified</span>
        </div>
        <div className="summary-item missing">
          <span className="summary-count">{summary.missingFromTarget}</span>
          <span className="summary-label">Missing</span>
        </div>
        <div className="summary-item extra">
          <span className="summary-count">{summary.extraInTarget}</span>
          <span className="summary-label">Extra</span>
        </div>
      </div>

      <div className="comparison-controls-bar">
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

      <div className="comparison-tree">
        {tree.map((item) => renderItem(item, "", 0))}
        {!showAll && totalDifferences === 0 && (
          <div className="no-differences">
            All files are identical! The folders match perfectly.
          </div>
        )}
      </div>
    </div>
  );
}
