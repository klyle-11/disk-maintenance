import * as React from "react";
import type { ComparisonSnapshot } from "../api-tauri";
import "./SnapshotStrip.css";

interface SnapshotStripProps {
  snapshots: ComparisonSnapshot[];
  currentSnapshotId: string | null;
  comparisonSnapshotId: string | null;
  onSelectSnapshot: (snapshot: ComparisonSnapshot) => void;
}

type StripState = "expanded" | "compact";

const STRIP_STATE_KEY = "snapshot-strip-state";

export function SnapshotStrip({
  snapshots,
  currentSnapshotId,
  comparisonSnapshotId,
  onSelectSnapshot,
}: SnapshotStripProps) {
  const [state, setState] = React.useState<StripState>(() => {
    const saved = localStorage.getItem(STRIP_STATE_KEY);
    return (saved === "compact" ? "compact" : "expanded") as StripState;
  });

  const isActive = (snapshot: ComparisonSnapshot) => {
    return snapshot.id === currentSnapshotId || snapshot.id === comparisonSnapshotId;
  };

  const toggleState = () => {
    const newState = state === "expanded" ? "compact" : "expanded";
    setState(newState);
    localStorage.setItem(STRIP_STATE_KEY, newState);
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
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 7) return `${diffDays}d ago`;
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  };

  const truncatePath = (path: string, maxLength = 20) => {
    if (path.length <= maxLength) return path;
    const parts = path.split(/[/\\]/);
    if (parts.length <= 2) return path.slice(0, maxLength - 3) + "...";

    const filename = parts[parts.length - 1];
    if (filename.length >= maxLength - 3) return filename.slice(0, maxLength - 3) + "...";

    return `.../${filename}`;
  };

  return (
    <footer className="snapshot-strip" data-state={state}>
      <button
        className="strip-toggle"
        onClick={toggleState}
        aria-label={state === "expanded" ? "Collapse" : "Expand"}
        type="button"
      >
        <span className={`toggle-icon ${state === "compact" ? "flipped" : ""}`}>
          ▼
        </span>
      </button>

      <div className="strip-header">
        <span className="strip-title">Snapshots</span>
        <span className="strip-count">{snapshots.length}</span>
      </div>

      <div className="strip-scroll">
        <div className="strip-cards">
          {snapshots.map((snapshot) => (
            <button
              key={snapshot.id}
              className={`strip-card ${isActive(snapshot) ? "active" : ""}`}
              onClick={() => onSelectSnapshot(snapshot)}
              type="button"
              aria-label={`View ${isComparison(snapshot) ? "comparison" : "snapshot"}: ${snapshot.rootPath}`}
              aria-pressed={isActive(snapshot)}
            >
              <span className="card-icon">
                {isComparison(snapshot) ? "📁↔" : "📁"}
              </span>
              <span className="card-info">
                <span className="card-name" title={snapshot.rootPath}>
                  {isComparison(snapshot) ? "Comparison" : truncatePath(snapshot.rootPath)}
                </span>
                <span className="card-date">{formatRelativeTime(snapshot.savedAt)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </footer>
  );
}
