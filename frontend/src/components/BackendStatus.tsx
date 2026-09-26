/**
 * Backend status banner.
 *
 * The app window opens immediately, before the backend is up, so the user
 * needs to see what is happening. Shows a quiet progress line while the
 * backend starts and an actionable message — with a retry and the log — when
 * it fails, instead of the modal error box the app used to throw.
 */

import { useState } from "react";
import type { BackendStatus as Status } from "../electron.d";
import "./BackendStatus.css";

interface Props {
  status: Status | null;
  /** True once /api/health has actually answered. */
  connected: boolean | null;
  onRetry: () => void;
}

export function BackendStatus({ status, connected, onRetry }: Props) {
  const [retrying, setRetrying] = useState(false);
  const [showLog, setShowLog] = useState(false);

  // Nothing to say once the backend is answering.
  if (connected === true) return null;

  // Outside Electron (a browser tab against a dev server) there is no
  // supervisor to report on; fall back to the connection state alone.
  const state = status?.state ?? (connected === false ? "error" : "starting");
  const isError = state === "error";

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const message = (() => {
    if (isError) return status?.detail || "Cannot reach the backend.";
    if (state === "restarting") return status?.detail || "Restarting the backend…";
    if (status?.detail) return status.detail;
    return "Starting the backend…";
  })();

  return (
    <div
      className={`backend-status ${isError ? "is-error" : "is-starting"}`}
      role={isError ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="backend-status-main">
        <span className={`backend-status-icon ${isError ? "" : "spin"}`} aria-hidden="true">
          {isError ? "!" : "◠"}
        </span>
        <div className="backend-status-text">
          <strong>{isError ? "Backend unavailable" : "Getting ready"}</strong>
          <span className="backend-status-detail">{message}</span>
        </div>
        {isError && (
          <div className="backend-status-actions">
            <button type="button" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry"}
            </button>
            {status?.recentLines?.length ? (
              <button type="button" className="ghost" onClick={() => setShowLog((v) => !v)}>
                {showLog ? "Hide log" : "Show log"}
              </button>
            ) : null}
            {window.electronAPI?.openBackendLog && (
              <button
                type="button"
                className="ghost"
                onClick={() => window.electronAPI?.openBackendLog()}
              >
                Open log file
              </button>
            )}
          </div>
        )}
      </div>

      {showLog && status?.recentLines?.length ? (
        <pre className="backend-status-log">{status.recentLines.join("\n")}</pre>
      ) : null}
    </div>
  );
}
