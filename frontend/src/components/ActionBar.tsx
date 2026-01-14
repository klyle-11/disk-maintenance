import { useState } from "react";
import {
  formatBytes,
  previewActions,
  executeActions,
} from "../api";
import type {
  Finding,
  PreviewActionsResponse,
  PreviewActionsRequest,
  ExecuteActionsRequest,
} from "../api";
import "./ActionBar.css";

interface ActionBarProps {
  selectedFindings: Finding[];
  onActionComplete: () => void;
}

export function ActionBar({ selectedFindings, onActionComplete }: ActionBarProps) {
  const [archiveRoot, setArchiveRoot] = useState("");
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [preview, setPreview] = useState<PreviewActionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Get all paths from selected findings
  const allPaths = selectedFindings.flatMap((f) => f.paths);
  const totalReclaimable = selectedFindings.reduce(
    (sum, f) => sum + f.estimatedReclaimableBytes,
    0
  );

  const handlePreviewMove = async () => {
    if (!archiveRoot.trim()) {
      setError("Please enter an archive destination path");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const payload: PreviewActionsRequest = {
        action: "move",
        paths: allPaths,
        archiveRoot,
      };
      const result = await previewActions(payload);
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    }
    setLoading(false);
  };

  const handlePreviewDelete = async () => {
    setError(null);
    setLoading(true);
    try {
      const payload: PreviewActionsRequest = {
        action: "delete",
        paths: allPaths,
      };
      const result = await previewActions(payload);
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    }
    setLoading(false);
  };

  const handleExecuteMove = async () => {
    setError(null);
    setLoading(true);
    try {
      const payload: ExecuteActionsRequest = {
        action: "move",
        paths: allPaths,
        archiveRoot,
      };
      const result = await executeActions(payload);
      if (result.success) {
        setSuccess(`Successfully moved ${result.moved} items`);
        setShowMoveModal(false);
        setPreview(null);
        onActionComplete();
      } else {
        setError(`Moved ${result.moved} items with errors: ${result.errors.join(", ")}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Move failed");
    }
    setLoading(false);
  };

  const handleExecuteDelete = async () => {
    setError(null);
    setLoading(true);
    try {
      const payload: ExecuteActionsRequest = {
        action: "delete",
        paths: allPaths,
      };
      const result = await executeActions(payload);
      if (result.success) {
        setSuccess(`Successfully deleted ${result.deleted} items`);
        setShowDeleteModal(false);
        setPreview(null);
        onActionComplete();
      } else {
        setError(`Deleted ${result.deleted} items with errors: ${result.errors.join(", ")}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
    setLoading(false);
  };

  const closeModals = () => {
    setShowMoveModal(false);
    setShowDeleteModal(false);
    setPreview(null);
    setError(null);
  };

  if (selectedFindings.length === 0) {
    return (
      <div className="action-bar empty">
        <span>Select findings to perform actions</span>
      </div>
    );
  }

  return (
    <>
      <div className="action-bar">
        <div className="selection-summary">
          <strong>{selectedFindings.length}</strong> finding(s) selected |{" "}
          <strong>{formatBytes(totalReclaimable)}</strong> estimated reclaimable
        </div>

        <div className="action-buttons">
          <button
            className="action-button move"
            onClick={() => {
              setShowMoveModal(true);
              setSuccess(null);
            }}
          >
            Move to Archive...
          </button>
          <button
            className="action-button delete"
            onClick={() => {
              setShowDeleteModal(true);
              setSuccess(null);
            }}
          >
            Delete Selected...
          </button>
        </div>

        {success && <div className="action-success">{success}</div>}
      </div>

      {/* Move Modal */}
      {showMoveModal && (
        <div className="modal-overlay" onClick={closeModals}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Move to Archive</h3>
            <p>
              Move <strong>{allPaths.length}</strong> item(s) to an archive location.
            </p>

            <div className="modal-input">
              <label>Archive destination:</label>
              <input
                type="text"
                placeholder="e.g., D:\Archive"
                value={archiveRoot}
                onChange={(e) => setArchiveRoot(e.target.value)}
              />
            </div>

            {preview && (
              <div className="preview-summary">
                <p>
                  <strong>{preview.totalItems}</strong> items totaling{" "}
                  <strong>{formatBytes(preview.totalBytes)}</strong> will be moved.
                </p>
              </div>
            )}

            {error && <div className="modal-error">{error}</div>}

            <div className="modal-actions">
              <button onClick={closeModals} disabled={loading}>
                Cancel
              </button>
              {!preview ? (
                <button onClick={handlePreviewMove} disabled={loading}>
                  {loading ? "Loading..." : "Preview"}
                </button>
              ) : (
                <button
                  className="confirm"
                  onClick={handleExecuteMove}
                  disabled={loading}
                >
                  {loading ? "Moving..." : "Confirm Move"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal */}
      {showDeleteModal && (
        <div className="modal-overlay" onClick={closeModals}>
          <div className="modal danger" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Items</h3>
            <p className="warning">
              This action is <strong>irreversible</strong>. The following items will be
              permanently deleted:
            </p>

            {!preview ? (
              <div className="preview-list">
                <p>
                  <strong>{allPaths.length}</strong> item(s) selected
                </p>
              </div>
            ) : (
              <div className="preview-summary">
                <p>
                  <strong>{preview.totalItems}</strong> items totaling{" "}
                  <strong>{formatBytes(preview.totalBytes)}</strong> will be{" "}
                  <strong>permanently deleted</strong>.
                </p>
              </div>
            )}

            {error && <div className="modal-error">{error}</div>}

            <div className="modal-actions">
              <button onClick={closeModals} disabled={loading}>
                Cancel
              </button>
              {!preview ? (
                <button onClick={handlePreviewDelete} disabled={loading}>
                  {loading ? "Loading..." : "Preview"}
                </button>
              ) : (
                <button
                  className="danger"
                  onClick={handleExecuteDelete}
                  disabled={loading}
                >
                  {loading ? "Deleting..." : "Confirm Delete"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// TODO: Add per-file review before executing actions
// TODO: Add undo functionality using quarantine
// TODO: Add batch progress indicator for large operations
