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

export interface ProgressEventData {
  scan_id: string;
  event_type: string;
  files_scanned: number;
  folders_scanned: number;
  bytes_scanned: number;
  current_path: string;
  progress_percent: number;
  elapsed_seconds: number;
  message: string;
  scan_response?: ScanResponse;
}

/** A single finding from a disk scan */
export interface Finding {
  id: string;
  category: string;
  reason: string;
  paths: string[];
  totalBytes: number;
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

/** A saved snapshot of scan results */
export interface Snapshot {
  id: string;
  scanId: string;
  rootPath: string;
  findings: Finding[];
  extensions: ExtensionSummary[];
  scanInfo: ScanResponse;
  savedAt: string;
  totalFiles: number;
  totalFolders: number;
  totalSizeBytes: number;
}

/** Status of a compared item */
export type ComparisonStatus =
  | "identical"
  | "modified"
  | "missing_from_target"
  | "extra_in_target";

/** A single item in the comparison tree */
export interface ComparisonItem {
  name: string;
  relativePath: string;
  itemType: "file" | "folder";
  status: ComparisonStatus;
  sourceSize: number | null;
  targetSize: number | null;
  sourceModified: string | null;
  targetModified: string | null;
  sourceHash: string | null;
  targetHash: string | null;
  children: ComparisonItem[] | null;
  differenceCount: number;
}

/** Summary of comparison results */
export interface ComparisonSummary {
  identical: number;
  modified: number;
  missingFromTarget: number;
  extraInTarget: number;
  totalSourceSize: number;
  totalTargetSize: number;
}

/** Response from a comparison */
export interface ComparisonResponse {
  comparisonId: string;
  sourcePath: string;
  targetPath: string;
  summary: ComparisonSummary;
  tree: ComparisonItem[];
  deepScan: boolean;
  completedAt: string;
}

/** Extended snapshot that may include comparison data */
export interface ComparisonSnapshot extends Snapshot {
  snapshotType: "scan" | "comparison";
  targetPath?: string;
  comparison?: ComparisonItem[];
  comparisonSummary?: ComparisonSummary;
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
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns A ScanResponse with scan_id and metadata.
 */
export async function scan(rootPath: string, signal?: AbortSignal): Promise<ScanResponse> {
  return apiFetch<ScanResponse>("/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root_path: rootPath }),
    signal,
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
 * Start a disk scan with real-time progress updates via SSE.
 * @param rootPath - The root directory path to scan.
 * @param onProgress - Callback for progress updates.
 * @param signal - Optional AbortSignal to cancel the scan.
 * @returns A ScanResponse with scan_id and metadata.
 */
export async function scanWithProgress(
  rootPath: string,
  onProgress: (event: ProgressEventData) => void,
  signal?: AbortSignal
): Promise<ScanResponse> {
  return new Promise((resolve, reject) => {
    const url = `${API_ENDPOINT}/scan/stream?root_path=${encodeURIComponent(rootPath)}`;
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const data: ProgressEventData = JSON.parse(event.data);

        if (data.event_type === 'progress') {
          onProgress(data);
        } else if (data.event_type === 'complete' && data.scan_response) {
          eventSource.close();
          const response = data.scan_response;
          resolve({
            scanId: (response as any).scan_id,
            rootPath: (response as any).root_path,
            startedAt: (response as any).started_at,
            completedAt: (response as any).completed_at,
            totalFiles: (response as any).total_files,
            totalFolders: (response as any).total_folders,
            totalSizeBytes: (response as any).total_size_bytes,
          });
        }
      } catch (err) {
        eventSource.close();
        reject(new Error('Failed to parse progress event'));
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      reject(new Error('Scan stream connection failed'));
    };

    if (signal) {
      signal.addEventListener('abort', () => {
        eventSource.close();
        reject(new Error('Scan cancelled'));
      });
    }
  });
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
    reason: item.reason,
    paths: item.paths,
    totalBytes: item.total_bytes,
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
 * Check if the backend is running and healthy.
 * @returns A health status object.
 */
export async function healthCheck(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/health");
}

/**
 * Save a snapshot of scan results.
 * @param scanId - The scan ID to save a snapshot of.
 * @param rootPath - The root path of the scan.
 * @returns The saved snapshot.
 */
export async function saveSnapshot(
  scanId: string,
  rootPath: string
): Promise<Snapshot> {
  const item = await apiFetch<any>("/snapshots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scan_id: scanId, root_path: rootPath }),
  });
  return {
    id: item.id,
    scanId: item.scan_id,
    rootPath: item.root_path,
    findings: (item.findings || []).map(transformFinding),
    extensions: (item.extensions || []).map(transformExtension),
    scanInfo: item.scan_info ? {
      scanId: item.scan_info.scan_id,
      rootPath: item.scan_info.root_path,
      startedAt: item.scan_info.started_at,
      completedAt: item.scan_info.completed_at,
      totalFiles: item.scan_info.total_files,
      totalFolders: item.scan_info.total_folders,
      totalSizeBytes: item.scan_info.total_size_bytes,
    } : {} as ScanResponse,
    savedAt: item.saved_at,
    totalFiles: item.total_files,
    totalFolders: item.total_folders,
    totalSizeBytes: item.total_size_bytes,
  };
}

/**
 * Transform snake_case Finding to camelCase
 */
function transformFinding(f: any): Finding {
  return {
    id: f.id,
    category: f.category,
    reason: f.reason,
    paths: f.paths || [],
    totalBytes: f.total_bytes || f.totalBytes || 0,
  };
}

/**
 * Transform snake_case ExtensionSummary to camelCase
 */
function transformExtension(e: any): ExtensionSummary {
  return {
    extension: e.extension,
    fileCount: e.file_count || e.fileCount || 0,
    totalBytes: e.total_bytes || e.totalBytes || 0,
  };
}

/**
 * Transform snake_case ComparisonItem to camelCase (recursive)
 */
function transformComparisonItem(item: any): ComparisonItem {
  return {
    name: item.name,
    relativePath: item.relative_path,
    itemType: item.item_type,
    status: item.status,
    sourceSize: item.source_size,
    targetSize: item.target_size,
    sourceModified: item.source_modified,
    targetModified: item.target_modified,
    sourceHash: item.source_hash,
    targetHash: item.target_hash,
    children: item.children?.map(transformComparisonItem) || null,
    differenceCount: item.difference_count || 0,
  };
}

/**
 * Transform snake_case ComparisonSummary to camelCase
 */
function transformComparisonSummary(summary: any): ComparisonSummary {
  return {
    identical: summary.identical || 0,
    modified: summary.modified || 0,
    missingFromTarget: summary.missing_from_target || 0,
    extraInTarget: summary.extra_in_target || 0,
    totalSourceSize: summary.total_source_size || 0,
    totalTargetSize: summary.total_target_size || 0,
  };
}

/**
 * Transform snapshot with comparison fields
 */
function transformSnapshot(item: any): ComparisonSnapshot {
  const base: ComparisonSnapshot = {
    id: item.id,
    scanId: item.scan_id,
    rootPath: item.root_path,
    findings: (item.findings || []).map(transformFinding),
    extensions: (item.extensions || []).map(transformExtension),
    scanInfo: item.scan_info ? {
      scanId: item.scan_info.scan_id,
      rootPath: item.scan_info.root_path,
      startedAt: item.scan_info.started_at,
      completedAt: item.scan_info.completed_at,
      totalFiles: item.scan_info.total_files,
      totalFolders: item.scan_info.total_folders,
      totalSizeBytes: item.scan_info.total_size_bytes,
    } : {} as ScanResponse,
    savedAt: item.saved_at,
    totalFiles: item.total_files,
    totalFolders: item.total_folders,
    totalSizeBytes: item.total_size_bytes,
    snapshotType: item.snapshot_type || "scan",
    targetPath: item.target_path,
  };

  if (item.comparison) {
    base.comparison = item.comparison.map(transformComparisonItem);
  }
  if (item.comparison_summary) {
    base.comparisonSummary = transformComparisonSummary(item.comparison_summary);
  }

  return base;
}

/**
 * Get all saved snapshots.
 * @returns An array of snapshots.
 */
export async function getSnapshots(): Promise<ComparisonSnapshot[]> {
  const data = await apiFetch<any[]>("/snapshots");
  return data.map(transformSnapshot);
}

/**
 * Get a specific snapshot by ID.
 * @param snapshotId - The ID of the snapshot to retrieve.
 * @returns The snapshot data.
 */
export async function getSnapshot(snapshotId: string): Promise<Snapshot> {
  const item = await apiFetch<any>(`/snapshots/${snapshotId}`);
  return {
    id: item.id,
    scanId: item.scan_id,
    rootPath: item.root_path,
    findings: (item.findings || []).map(transformFinding),
    extensions: (item.extensions || []).map(transformExtension),
    scanInfo: item.scan_info ? {
      scanId: item.scan_info.scan_id,
      rootPath: item.scan_info.root_path,
      startedAt: item.scan_info.started_at,
      completedAt: item.scan_info.completed_at,
      totalFiles: item.scan_info.total_files,
      totalFolders: item.scan_info.total_folders,
      totalSizeBytes: item.scan_info.total_size_bytes,
    } : {} as ScanResponse,
    savedAt: item.saved_at,
    totalFiles: item.total_files,
    totalFolders: item.total_folders,
    totalSizeBytes: item.total_size_bytes,
  };
}

/**
 * Update a snapshot by re-scanning its path.
 * @param snapshotId - The ID of the snapshot to update.
 * @returns The updated snapshot.
 */
export async function updateSnapshot(snapshotId: string): Promise<Snapshot> {
  const item = await apiFetch<any>(`/snapshots/${snapshotId}`, {
    method: "PUT",
  });
  return {
    id: item.id,
    scanId: item.scan_id,
    rootPath: item.root_path,
    findings: (item.findings || []).map(transformFinding),
    extensions: (item.extensions || []).map(transformExtension),
    scanInfo: item.scan_info ? {
      scanId: item.scan_info.scan_id,
      rootPath: item.scan_info.root_path,
      startedAt: item.scan_info.started_at,
      completedAt: item.scan_info.completed_at,
      totalFiles: item.scan_info.total_files,
      totalFolders: item.scan_info.total_folders,
      totalSizeBytes: item.scan_info.total_size_bytes,
    } : {} as ScanResponse,
    savedAt: item.saved_at,
    totalFiles: item.total_files,
    totalFolders: item.total_folders,
    totalSizeBytes: item.total_size_bytes,
  };
}

/**
 * Delete a snapshot.
 * @param snapshotId - The ID of the snapshot to delete.
 * @returns A success message.
 */
export async function deleteSnapshot(
  snapshotId: string
): Promise<{ message: string }> {
  return apiFetch<{ message: string }>(`/snapshots/${snapshotId}`, {
    method: "DELETE",
  });
}

// ============================================================================
// Comparison API functions
// ============================================================================

/**
 * Compare two directories.
 * @param sourcePath - The source directory path.
 * @param targetPath - The target directory path.
 * @param deepScan - Whether to verify with file hashes.
 * @returns Comparison results.
 */
export async function compareDirectories(
  sourcePath: string,
  targetPath: string,
  deepScan: boolean = false
): Promise<ComparisonResponse> {
  const data = await apiFetch<any>("/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_path: sourcePath,
      target_path: targetPath,
      deep_scan: deepScan,
    }),
  });

  return {
    comparisonId: data.comparison_id,
    sourcePath: data.source_path,
    targetPath: data.target_path,
    summary: transformComparisonSummary(data.summary),
    tree: data.tree.map(transformComparisonItem),
    deepScan: data.deep_scan,
    completedAt: data.completed_at,
  };
}

/**
 * Save a comparison as a snapshot.
 */
export async function saveComparisonSnapshot(
  sourcePath: string,
  targetPath: string,
  comparisonId: string
): Promise<ComparisonSnapshot> {
  const params = new URLSearchParams({
    source_path: sourcePath,
    target_path: targetPath,
    comparison_id: comparisonId,
  });

  const item = await apiFetch<any>(`/snapshots/comparison?${params}`, {
    method: "POST",
  });

  return transformSnapshot(item);
}

/**
 * Update a comparison snapshot by re-running the comparison.
 */
export async function updateComparisonSnapshot(
  snapshotId: string
): Promise<ComparisonSnapshot> {
  const item = await apiFetch<any>(`/snapshots/comparison/${snapshotId}`, {
    method: "PUT",
  });

  return transformSnapshot(item);
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
