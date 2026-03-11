import * as React from "react";
import type { ComparisonSnapshot } from "../api-tauri";
import "./SnapshotSidebar.css";

interface SnapshotSidebarProps {
  snapshots: ComparisonSnapshot[];
  currentSnapshotId: string | null;
  comparisonSnapshotId: string | null;
  onSelectSnapshot: (snapshot: ComparisonSnapshot) => void;
}

type SidebarState = "collapsed" | "expanded";

const SIDEBAR_STATE_KEY = "snapshot-sidebar-state";

export function SnapshotSidebar({
  snapshots,
  currentSnapshotId,
  comparisonSnapshotId,
  onSelectSnapshot,
}: SnapshotSidebarProps) {
  const [state, setState] = React.useState<SidebarState>(() => {
    const saved = localStorage.getItem(SIDEBAR_STATE_KEY);
    return (saved === "expanded" ? "expanded" : "collapsed") as SidebarState;
  });

  const isActive = (snapshot: ComparisonSnapshot) => {
    return snapshot.id === currentSnapshotId || snapshot.id === comparisonSnapshotId;
  };

  const toggleState = () => {
    const newState = state === "expanded" ? "collapsed" : "expanded";
    setState(newState);
    localStorage.setItem(SIDEBAR_STATE_KEY, newState);
  };

  const isComparison = (snapshot: ComparisonSnapshot) => {
    return snapshot.snapshotType === "comparison";
  };

  const formatRelativeTime = (dateString: string) => {
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return "just now";
      if (diffMins < 60) return `${diffMins}m`;
      if (diffHours < 24) return `${diffHours}h`;
      if (diffDays < 7) return `${diffDays}d`;
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  };

  const formatFullDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return dateString;
    }
  };

  const truncatePath = (path: string, maxLength = 18) => {
    if (path.length <= maxLength) return path;
    const parts = path.split(/[/\\]/);
    if (parts.length <= 2) return path.slice(0, maxLength - 3) + "...";

    const filename = parts[parts.length - 1];
    if (filename.length >= maxLength - 3) return filename.slice(0, maxLength - 3) + "...";

    return `.../${filename}`;
  };

  return (
    <>
      {/* Toggle Button - Always Visible */}
      <button
        className="sidebar-toggle"
        onClick={toggleState}
        aria-label={state === "expanded" ? "Collapse snapshots" : "Expand snapshots"}
        type="button"
        data-state={state}
      >
        <span className="toggle-icon">
          {state === "expanded" ? "»" : "«"}
        </span>
        <span className="toggle-badge">{snapshots.length}</span>
      </button>

      {/* Sidebar Panel */}
      <aside className="snapshot-sidebar" data-state={state}>
        <div className="sidebar-header">
          <span className="sidebar-title">Snapshots</span>
          <span className="sidebar-count">{snapshots.length}</span>
        </div>

        <div className="sidebar-content">
          {snapshots.length === 0 ? (
            <div className="sidebar-empty">
              <span className="empty-icon">📸</span>
              <span className="empty-text">No snapshots yet</span>
            </div>
          ) : (
            <div className="sidebar-list">
              {snapshots.map((snapshot) => (
                <button
                  key={snapshot.id}
                  className={`sidebar-item ${isActive(snapshot) ? "active" : ""}`}
                  onClick={() => onSelectSnapshot(snapshot)}
                  type="button"
                  title={`${isComparison(snapshot) ? "Comparison" : "Snapshot"}: ${snapshot.rootPath}\nSaved: ${formatFullDate(snapshot.savedAt)}`}
                >
                  <span className="item-icon">
                    {isComparison(snapshot) ? "🔀" : "📁"}
                  </span>
                  <div className="item-details">
                    <span className="item-name">
                      {isComparison(snapshot) ? "Comparison" : truncatePath(snapshot.rootPath)}
                    </span>
                    <span className="item-meta">
                      {isComparison(snapshot) && (
                        <span className="item-paths">
                          {truncatePath(snapshot.rootPath, 12)} ↔ {truncatePath(snapshot.targetPath || "", 12)}
                        </span>
                      )}
                      <span className="item-date">{formatRelativeTime(snapshot.savedAt)}</span>
                    </span>
                  </div>
                  {isActive(snapshot) && <span className="item-indicator">●</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
