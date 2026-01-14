/**
 * Frontend API client for Disk Intelligence backend.
 * Handles all HTTP communication with the FastAPI backend via fetch.
 */

// ============================================================================
// Configuration
// ============================================================================

/** Base URL for the API, configurable via VITE_API_BASE_URL env var */
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8001";

const API_ENDPOINT = `${API_BASE_URL}/api`;

// ============================================================================
// Types
// ============================================================================

export type RiskLevel = "low" | "medium" | "high";
export type ConfidenceLevel = "low" | "medium" | "high";
export type ActionType = "move" | "delete";

/** A single finding from a disk scan */
export interface Finding {
  id: string;
  category: string;
  confidence: ConfidenceLevel;
  reason: string;
  paths: string[];
  estimatedReclaimableBytes: number;
  riskLevel: RiskLevel;
  score: number;
}

/** Response from a completed disk scan */
export interface ScanResponse {
  scanId: string;
  rootPath: string;
  startedAt: string;
  completedAt: string;
  totalFiles: number;
  totalFolders: number;
  totalSizeBytes: number;
}

/** File extension summary from a scan */
export interface ExtensionSummary {
  extension: string;
  fileCount: number;
  totalBytes: number;
}

/** Request payload for previewing actions */
export interface PreviewActionsRequest {
  action: ActionType;
  paths: string[];
  archiveRoot?: string;
}

/** Response from previewing actions */
export interface PreviewActionsResponse {
  totalItems: number;
  totalBytes: number;
}

/** Request payload for executing actions */
export interface ExecuteActionsRequest {
  action: ActionType;
  paths: string[];
  archiveRoot?: string;
}

/** Response from executing actions */
export interface ExecuteActionsResponse {
  success: boolean;
  moved: number;
  deleted: number;
  errors: string[];
}

// ============================================================================
// Private helper
// ============================================================================

/**
 * Helper function to make typed API calls.
 * Throws an Error on non-2xx responses with a meaningful message.
 */
async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_ENDPOINT}${path}`;
  const response = await fetch(url, options);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${options?.method || "GET"} ${path} failed with ${response.status}: ${body || response.statusText}`
    );
  }

  return response.json();
}

// ============================================================================
// API functions
// ============================================================================

/**
 * Start a disk scan for the given root path.
 * @param rootPath - The root directory path to scan.
 * @returns A ScanResponse with scan_id and metadata.
 */
export async function scan(rootPath: string): Promise<ScanResponse> {
  return apiFetch<ScanResponse>("/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root_path: rootPath }),
  }).then((data) => ({
    scanId: (data as any).scan_id,
    rootPath: (data as any).root_path,
    startedAt: (data as any).started_at,
    completedAt: (data as any).completed_at,
    totalFiles: (data as any).total_files,
    totalFolders: (data as any).total_folders,
    totalSizeBytes: (data as any).total_size_bytes,
  }));
}

/**
 * Fetch findings for a completed scan.
 * @param scanId - The scan ID to fetch findings for.
 * @returns An array of Finding objects.
 */
export async function getFindings(scanId: string): Promise<Finding[]> {
  const data = await apiFetch<any[]>(`/findings?scan_id=${scanId}`);
  return data.map((item) => ({
    id: item.id,
    category: item.category,
    confidence: item.confidence as ConfidenceLevel,
    reason: item.reason,
    paths: item.paths,
    estimatedReclaimableBytes: item.estimated_reclaimable_bytes,
    riskLevel: item.risk_level as RiskLevel,
    score: item.score,
  }));
}

/**
 * Fetch file extension summary for a completed scan.
 * @param scanId - The scan ID to fetch extension summary for.
 * @returns An array of ExtensionSummary objects.
 */
export async function getExtensionSummary(
  scanId: string
): Promise<ExtensionSummary[]> {
  const data = await apiFetch<any[]>(`/extensions-summary?scan_id=${scanId}`);
  return data.map((item) => ({
    extension: item.extension,
    fileCount: item.file_count,
    totalBytes: item.total_bytes,
  }));
}

/**
 * Preview what would happen if actions were executed on the given paths.
 * @param payload - The action preview request payload.
 * @returns A PreviewActionsResponse with item and size estimates.
 */
export async function previewActions(
  payload: PreviewActionsRequest
): Promise<PreviewActionsResponse> {
  const data = await apiFetch<any>("/preview-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: payload.action,
      paths: payload.paths,
      ...(payload.archiveRoot && { archive_root: payload.archiveRoot }),
    }),
  });
  return {
    totalItems: data.total_items,
    totalBytes: data.total_bytes,
  };
}

/**
 * Execute an action (move or delete) on the given paths.
 * @param payload - The action execution request payload.
 * @returns An ExecuteActionsResponse with success status and counts.
 */
export async function executeActions(
  payload: ExecuteActionsRequest
): Promise<ExecuteActionsResponse> {
  return apiFetch<ExecuteActionsResponse>("/execute-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: payload.action,
      paths: payload.paths,
      ...(payload.archiveRoot && { archive_root: payload.archiveRoot }),
    }),
  });
}

/**
 * Check if the backend is running and healthy.
 * @returns A health status object.
 */
export async function healthCheck(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/health");
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Format bytes as a human-readable string (B, KB, MB, GB, TB).
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Get display name for a category.
 */
export function getCategoryDisplayName(category: string): string {
  const names: Record<string, string> = {
    temp_files: "Temp Files",
    large_files: "Large Files",
    duplicates: "Duplicates",
    cache_folders: "Cache Folders",
    old_files: "Old Files",
    system_junk: "System Junk",
  };
  return names[category] || category.replace(/_/g, " ");
}

/**
 * Get color for a risk level.
 */
export function getRiskColor(riskLevel: RiskLevel): string {
  const colors: Record<RiskLevel, string> = {
    low: "#4CAF50",
    medium: "#FFC107",
    high: "#F44336",
  };
  return colors[riskLevel];
}

/**
 * Get label for a risk level.
 */
export function getRiskLabel(riskLevel: RiskLevel): string {
  return riskLevel.charAt(0).toUpperCase() + riskLevel.slice(1);
}
