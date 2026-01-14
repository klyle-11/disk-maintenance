import { useState } from "react";
import { scan, formatBytes } from "../api";
import type { ScanResponse } from "../api";
import "./ScanControls.css";

export type ScanStatus = "idle" | "scanning" | "completed" | "error";

interface ScanControlsProps {
  onScanComplete: (scanId: string, scanInfo: ScanResponse) => void;
  status: ScanStatus;
  setStatus: (status: ScanStatus) => void;
  scanInfo: ScanResponse | null;
}

export function ScanControls({
  onScanComplete,
  status,
  setStatus,
  scanInfo,
}: ScanControlsProps) {
  const [rootPath, setRootPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleScan = async () => {
    if (!rootPath.trim()) {
      setError("Please enter a path to scan");
      return;
    }

    setError(null);
    setStatus("scanning");

    try {
      const result = await scan(rootPath.trim());
      setStatus("completed");
      onScanComplete(result.scanId, result);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Scan failed");
    }
  };

  const getStatusBadge = () => {
    switch (status) {
      case "idle":
        return <span className="status-badge idle">Ready</span>;
      case "scanning":
        return <span className="status-badge scanning">Scanning...</span>;
      case "completed":
        return <span className="status-badge completed">Completed</span>;
      case "error":
        return <span className="status-badge error">Error</span>;
    }
  };

  return (
    <div className="scan-controls">
      <div className="scan-header">
        <h2>Disk Intelligence</h2>
        {getStatusBadge()}
      </div>

      <div className="scan-input-row">
        <input
          type="text"
          className="path-input"
          placeholder="Enter path to scan (e.g., C:\Users\YourName)"
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleScan()}
          disabled={status === "scanning"}
        />
        <button
          className="scan-button"
          onClick={handleScan}
          disabled={status === "scanning"}
        >
          {status === "scanning" ? "Scanning..." : "Scan & Analyze"}
        </button>
      </div>

      {error && <div className="scan-error">{error}</div>}

      {scanInfo && status === "completed" && (
        <div className="scan-summary">
          <div className="summary-item">
            <span className="summary-label">Path:</span>
            <span className="summary-value">{scanInfo.rootPath}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">Files:</span>
            <span className="summary-value">
              {scanInfo.totalFiles.toLocaleString()}
            </span>
          </div>
          <div className="summary-item">
            <span className="summary-label">Folders:</span>
            <span className="summary-value">
              {scanInfo.totalFolders.toLocaleString()}
            </span>
          </div>
          <div className="summary-item">
            <span className="summary-label">Total Size:</span>
            <span className="summary-value">
              {formatBytes(scanInfo.totalSizeBytes)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
