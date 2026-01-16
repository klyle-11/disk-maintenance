import { useState, useRef, useEffect } from "react";
import { scanWithProgress, compareDirectories, formatBytes } from "../api";
import type { ScanResponse, ComparisonResponse } from "../api";
import "./ScanControls.css";

export type ScanStatus = "idle" | "scanning" | "completed" | "error" | "comparing";

interface ScanControlsProps {
  onScanComplete: (scanId: string, scanInfo: ScanResponse) => void;
  onComparisonComplete: (result: ComparisonResponse) => void;
  status: ScanStatus;
  setStatus: (status: ScanStatus) => void;
  scanInfo: ScanResponse | null;
}

interface LogEntry {
  timestamp: string;
  message: string;
  type: "info" | "success" | "error";
}

export function ScanControls({
  onScanComplete,
  onComparisonComplete,
  status,
  setStatus,
  scanInfo,
}: ScanControlsProps) {
  const [rootPath, setRootPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsExpanded, setLogsExpanded] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const logsContentRef = useRef<HTMLDivElement>(null);
  const lockedToBottomRef = useRef<boolean>(true);

  // Comparison mode state
  const [compareMode, setCompareMode] = useState(false);
  const [targetPath, setTargetPath] = useState("");
  const [deepScan, setDeepScan] = useState(false);
  const targetFileInputRef = useRef<HTMLInputElement>(null);

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { timestamp, message, type }]);
  };

  const handleLogsScroll = () => {
    const el = logsContentRef.current;
    if (!el) return;

    const atBottom =
      el.scrollTop + el.clientHeight === el.scrollHeight;

    if (!atBottom) {
      // User scrolled up even slightly → unlock
      lockedToBottomRef.current = false;
    } else {
      // User scrolled back to bottom → re-lock
      lockedToBottomRef.current = true;
    }
  };

  useEffect(() => {
    const el = logsContentRef.current;
    if (!el) return;

    if (lockedToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const handleDirectorySelect = async () => {
    // Use native Electron dialog if available
    if (window.electronAPI) {
      try {
        const selectedPath = await window.electronAPI.selectDirectory();
        if (selectedPath) {
          setRootPath(selectedPath);
        }
        // If null (cancelled), do nothing
      } catch (err) {
        console.error('Failed to open directory dialog:', err);
        setError('Failed to open directory selection dialog');
      }
    } else {
      // Fall back to HTML5 file input for browser environment
      fileInputRef.current?.click();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      // Get the path from the first file
      const firstFile = files[0];
      // Extract directory path from the file path
      const fullPath = (firstFile as any).path || firstFile.webkitRelativePath;
      if (fullPath) {
        // Get the directory path (remove the file name)
        const dirPath = fullPath.substring(0, fullPath.lastIndexOf('\\') || fullPath.lastIndexOf('/'));
        setRootPath(dirPath || fullPath);
      }
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setStatus("idle");
      addLog("Scan cancelled by user", "error");
    }
  };

  const handleScan = async () => {
    if (!rootPath.trim()) {
      setError("Please select a directory to scan");
      return;
    }

    setError(null);
    setLogs([]);
    setStatus("scanning");
    setLogsExpanded(true);

    abortControllerRef.current = new AbortController();

    addLog(`Starting scan of: ${rootPath.trim()}`, "info");

    try {
      const result = await scanWithProgress(
        rootPath.trim(),
        (progressEvent) => {
          const msg = `[${progressEvent.progress_percent}%] ${progressEvent.message} (${progressEvent.files_scanned} files, ${progressEvent.folders_scanned} folders)`;
          addLog(msg, "info");
        },
        abortControllerRef.current.signal
      );

      abortControllerRef.current = null;
      setStatus("completed");
      addLog(`Scan completed successfully`, "success");
      addLog(`Found ${result.totalFiles.toLocaleString()} files in ${result.totalFolders.toLocaleString()} folders`, "success");
      addLog(`Total size: ${formatBytes(result.totalSizeBytes)}`, "success");
      onScanComplete(result.scanId, result);
    } catch (err) {
      abortControllerRef.current = null;

      if (err instanceof Error && err.message === 'Scan cancelled') {
        return;
      }

      setStatus("error");
      const errorMsg = err instanceof Error ? err.message : "Scan failed";
      setError(errorMsg);
      addLog(`Error: ${errorMsg}`, "error");
    }
  };

  const handleTargetDirectorySelect = async () => {
    if (window.electronAPI) {
      try {
        const selectedPath = await window.electronAPI.selectDirectory();
        if (selectedPath) {
          setTargetPath(selectedPath);
        }
      } catch (err) {
        console.error('Failed to open directory dialog:', err);
        setError('Failed to open directory selection dialog');
      }
    } else {
      targetFileInputRef.current?.click();
    }
  };

  const handleTargetFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const firstFile = files[0];
      const fullPath = (firstFile as any).path || firstFile.webkitRelativePath;
      if (fullPath) {
        const dirPath = fullPath.substring(0, fullPath.lastIndexOf('\\') || fullPath.lastIndexOf('/'));
        setTargetPath(dirPath || fullPath);
      }
    }
  };

  const handleCompare = async () => {
    if (!rootPath.trim() || !targetPath.trim()) {
      setError("Please select both source and target directories");
      return;
    }

    setError(null);
    setLogs([]);
    setStatus("comparing");
    setLogsExpanded(true);

    addLog(`Comparing: ${rootPath.trim()} vs ${targetPath.trim()}`, "info");
    if (deepScan) {
      addLog("Deep scan enabled - verifying file contents with hashes", "info");
    }

    try {
      const result = await compareDirectories(
        rootPath.trim(),
        targetPath.trim(),
        deepScan
      );

      setStatus("completed");
      addLog("Comparison completed successfully", "success");
      addLog(
        `Found: ${result.summary.identical} identical, ${result.summary.modified} modified, ` +
        `${result.summary.missingFromTarget} missing, ${result.summary.extraInTarget} extra`,
        "success"
      );
      onComparisonComplete(result);
    } catch (err) {
      setStatus("error");
      const errorMsg = err instanceof Error ? err.message : "Comparison failed";
      setError(errorMsg);
      addLog(`Error: ${errorMsg}`, "error");
    }
  };

  const getStatusBadge = () => {
    switch (status) {
      case "idle":
        return <span className="status-badge idle">Ready</span>;
      case "scanning":
        return <span className="status-badge scanning">Scanning...</span>;
      case "comparing":
        return <span className="status-badge scanning">Comparing...</span>;
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
        {!window.electronAPI && (
          <input
            ref={fileInputRef}
            type="file"
            /* @ts-ignore - webkitdirectory is not in TypeScript types */
            webkitdirectory=""
            directory=""
            multiple
            style={{ display: "none" }}
            onChange={handleFileInputChange}
          />
        )}
        <button
          className="select-directory-button"
          onClick={handleDirectorySelect}
          disabled={status === "scanning" || status === "comparing"}
        >
          {rootPath ? (compareMode ? "Change Source" : "Change Directory") : (compareMode ? "Select Source" : "Select Directory")}
        </button>
        {rootPath && (
          <div className="selected-path" title={rootPath}>
            {rootPath}
          </div>
        )}
        {!compareMode && (
          status === "scanning" ? (
            <button className="cancel-button" onClick={handleCancel}>
              Cancel Scan
            </button>
          ) : (
            <button
              className="scan-button"
              onClick={handleScan}
              disabled={!rootPath}
            >
              Scan & Analyze
            </button>
          )
        )}
      </div>

      <div className="compare-toggle">
        <label>
          <input
            type="checkbox"
            checked={compareMode}
            onChange={(e) => setCompareMode(e.target.checked)}
            disabled={status === "scanning" || status === "comparing"}
          />
          Compare with another folder
        </label>
      </div>

      {compareMode && (
        <div className="comparison-controls">
          <div className="scan-input-row">
            {!window.electronAPI && (
              <input
                ref={targetFileInputRef}
                type="file"
                /* @ts-ignore */
                webkitdirectory=""
                directory=""
                multiple
                style={{ display: "none" }}
                onChange={handleTargetFileInputChange}
              />
            )}
            <button
              className="select-directory-button target"
              onClick={handleTargetDirectorySelect}
              disabled={status === "scanning" || status === "comparing"}
            >
              {targetPath ? "Change Target" : "Select Target"}
            </button>
            {targetPath && (
              <div className="selected-path" title={targetPath}>
                {targetPath}
              </div>
            )}
            <button
              className="compare-button"
              onClick={handleCompare}
              disabled={!rootPath || !targetPath || status === "comparing"}
            >
              {status === "comparing" ? "Comparing..." : "Compare"}
            </button>
          </div>
          <div className="deep-scan-toggle">
            <label>
              <input
                type="checkbox"
                checked={deepScan}
                onChange={(e) => setDeepScan(e.target.checked)}
                disabled={status === "comparing"}
              />
              Deep scan (verify file contents with hashes)
            </label>
          </div>
        </div>
      )}

      {error && <div className="scan-error">{error}</div>}

      {logs.length > 0 && (
        <div className="logs-section">
          <button
            className="logs-toggle"
            onClick={() => setLogsExpanded(!logsExpanded)}
          >
            <span className={`toggle-icon ${logsExpanded ? "expanded" : ""}`}>
              ▶
            </span>
            Scan Logs ({logs.length})
          </button>
          {logsExpanded && (
            <div className="logs-content" ref={logsContentRef} onScroll={handleLogsScroll}>
              {logs.map((log, index) => (
                <div key={index} className={`log-entry log-${log.type}`}>
                  <span className="log-timestamp">[{log.timestamp}]</span>
                  <span className="log-message">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
