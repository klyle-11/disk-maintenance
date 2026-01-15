import type { Snapshot } from "../api";
import { formatBytes } from "../api";
import "./SnapshotGallery.css";

interface SnapshotGalleryProps {
  snapshots: Snapshot[];
  onSelectSnapshot: (snapshot: Snapshot) => void;
  onDeleteSnapshot: (snapshotId: string) => void;
}

export function SnapshotGallery({
  snapshots,
  onSelectSnapshot,
  onDeleteSnapshot,
}: SnapshotGalleryProps) {
  console.log("SnapshotGallery received snapshots:", snapshots);

  if (!snapshots || snapshots.length === 0) {
    return (
      <div className="snapshot-gallery-empty">
        <p>No saved snapshots yet. Run a scan and save it to track changes over time.</p>
      </div>
    );
  }

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "Unknown date";
    }
  };

  return (
    <div className="snapshot-gallery">
      <h3>Saved Snapshots</h3>
      <div className="snapshot-cards">
        {snapshots.filter(s => s && s.id).map((snapshot) => (
          <div
            key={snapshot.id}
            className="snapshot-card"
            onClick={() => {
              console.log("Snapshot card clicked:", snapshot);
              onSelectSnapshot(snapshot);
            }}
          >
            <div className="snapshot-header">
              <h4 className="snapshot-path">{snapshot.rootPath}</h4>
              <button
                className="snapshot-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  if (
                    window.confirm(
                      `Are you sure you want to delete this snapshot of "${snapshot.rootPath}"?`
                    )
                  ) {
                    onDeleteSnapshot(snapshot.id);
                  }
                }}
                title="Delete snapshot"
              >
                ×
              </button>
            </div>

            <div className="snapshot-info">
              <div className="snapshot-stat">
                <span className="stat-label">Files:</span>
                <span className="stat-value">
                  {(snapshot.totalFiles || 0).toLocaleString()}
                </span>
              </div>
              <div className="snapshot-stat">
                <span className="stat-label">Size:</span>
                <span className="stat-value">
                  {formatBytes(snapshot.totalSizeBytes || 0)}
                </span>
              </div>
              <div className="snapshot-stat">
                <span className="stat-label">Findings:</span>
                <span className="stat-value">{snapshot.findings?.length || 0}</span>
              </div>
            </div>

            <div className="snapshot-date">
              Saved {formatDate(snapshot.savedAt || new Date().toISOString())}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
