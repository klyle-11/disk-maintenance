/**
 * Frontend API client for Disk Intelligence backend.
 * Handles all HTTP communication with the FastAPI backend via fetch.
 */

// ============================================================================
// Configuration
// ============================================================================

/**
 * SECURITY: Validate that API URL is localhost-only (CRITICAL-003, CRITICAL-005)
 * Throws an error if the URL is not localhost.
 */
function validateLocalhostUrl(url: string): void {
  try {
    const parsedUrl = new URL(url);

    // Check if hostname is localhost
    const allowedHosts = [
      'localhost',
      '127.0.0.1',
      '::1',
      '0.0.0.0',
    ];

    const hostname = parsedUrl.hostname.toLowerCase();

    if (!allowedHosts.includes(hostname)) {
      throw new Error(
        `SECURITY: API URL must be localhost only. Got: ${hostname}. ` +
        `This prevents external network calls (CRITICAL-005).`
      );
    }

    // Ensure the URL uses http or https (no other protocols)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(
        `SECURITY: API URL must use HTTP/HTTPS. Got: ${parsedUrl.protocol}`
      );
    }

  } catch (error) {
    if (error instanceof Error) {
      console.error('[SECURITY]', error.message);
      throw error;
    }
    throw new Error('SECURITY: Invalid API URL format');
  }
}

/**
 * Base URL for the API, configurable via VITE_API_BASE_URL env var.
 * SECURITY: Validates that the URL is localhost-only (CRITICAL-003, CRITICAL-005)
 */
const rawApiBaseUrl = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8001";
validateLocalhostUrl(rawApiBaseUrl);

export const API_BASE_URL = rawApiBaseUrl;

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

/** Default request timeout in milliseconds (10 seconds) */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Extended timeout for long-running operations (10 minutes) */
const LONG_TIMEOUT_MS = 600_000;

/** Short timeout for quick connectivity checks (5 seconds) */
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * Helper function to make typed API calls.
 * Throws an Error on non-2xx responses or timeout with a meaningful message.
 */
async function apiFetch<T>(
  path: string,
  options?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const url = `${API_ENDPOINT}${path}`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const existingSignal = options?.signal;

  // Link existing signal if provided
  if (existingSignal) {
    if (existingSignal.aborted) {
      controller.abort(existingSignal.reason);
    } else {
      existingSignal.addEventListener("abort", () =>
        controller.abort(existingSignal.reason)
      );
    }
  }

  const timeoutId = setTimeout(() => {
    controller.abort("timeout");
    console.error(`[API] Request timed out after ${timeoutMs}ms: ${options?.method || "GET"} ${path}`);
  }, timeoutMs);

  console.log(`[API] ${options?.method || "GET"} ${path}`);

  try {
    const { timeoutMs: _, ...fetchOptions } = options || {};
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const body = await response.text();
      const errMsg = `${options?.method || "GET"} ${path} failed with ${response.status}: ${body || response.statusText}`;
      console.error(`[API] ${errMsg}`);
      throw new Error(errMsg);
    }

    const data = await response.json();
    console.log(`[API] ${options?.method || "GET"} ${path} completed`);
    return data;
  } catch (err: any) {
    clearTimeout(timeoutId);

    // Detect abort (timeout or user cancellation)
    const isAbort =
      (err instanceof DOMException && err.name === "AbortError") ||
      err?.name === "AbortError" ||
      controller.signal.aborted;

    if (isAbort) {
      if (existingSignal?.aborted) {
        throw new Error("Request cancelled");
      }
      const timeoutErr = new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s: ${options?.method || "GET"} ${path} — backend may be unresponsive`
      );
      console.error(`[API]`, timeoutErr.message);
      throw timeoutErr;
    }

    if (err instanceof TypeError) {
      const connErr = new Error(
        `Cannot connect to backend at ${API_BASE_URL} — is the server running?`
      );
      console.error(`[API]`, connErr.message);
      throw connErr;
    }

    throw err;
  }
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
    timeoutMs: LONG_TIMEOUT_MS,
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
  const data = await apiFetch<any[]>(`/findings?scan_id=${scanId}`, {
    timeoutMs: LONG_TIMEOUT_MS,
  });
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
  const data = await apiFetch<any[]>(`/extensions-summary?scan_id=${scanId}`, {
    timeoutMs: LONG_TIMEOUT_MS,
  });
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
  return apiFetch<{ status: string }>("/health", { timeoutMs: HEALTH_TIMEOUT_MS });
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
    timeoutMs: LONG_TIMEOUT_MS,
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
  const data = await apiFetch<any[]>("/snapshots", {
    timeoutMs: LONG_TIMEOUT_MS,
  });
  return data.map(transformSnapshot);
}

/**
 * Get a specific snapshot by ID.
 * @param snapshotId - The ID of the snapshot to retrieve.
 * @returns The snapshot data.
 */
export async function getSnapshot(snapshotId: string): Promise<Snapshot> {
  const item = await apiFetch<any>(`/snapshots/${snapshotId}`, {
    timeoutMs: LONG_TIMEOUT_MS,
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
 * Update a snapshot by re-scanning its path.
 * @param snapshotId - The ID of the snapshot to update.
 * @returns The updated snapshot.
 */
export async function updateSnapshot(snapshotId: string): Promise<Snapshot> {
  const item = await apiFetch<any>(`/snapshots/${snapshotId}`, {
    method: "PUT",
    timeoutMs: LONG_TIMEOUT_MS,
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
    timeoutMs: LONG_TIMEOUT_MS,
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
    timeoutMs: LONG_TIMEOUT_MS,
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
    timeoutMs: LONG_TIMEOUT_MS,
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

// ============================================================================
// Du-Hast-Much API functions
// ============================================================================

/** Result from a du-hast-much scan */
export interface DuHastMuchResult {
  name: string;
  path: string;
  size: number;
  files: number;
  latest_mtime: number;
  avg_file_size: number;
}

/** Response from du-hast-much endpoint */
export interface DuHastMuchResponse {
  results: DuHastMuchResult[];
  total_size: number;
  total_files: number;
  elapsed_seconds: number;
}

/** Request options for du-hast-much scan */
export interface DuHastMuchRequest {
  path: string;
  depth?: number;
  top?: number;
  latest?: boolean;
  exclude?: string[];
}

/**
 * Run a du-hast-much scan on a directory.
 * @param request - The scan options.
 * @returns DuHastMuchResponse with scan results.
 */
export async function runDuHastMuch(
  request: DuHastMuchRequest
): Promise<DuHastMuchResponse> {
  const data = await apiFetch<any>("/du-hast-much", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: request.path,
      depth: request.depth ?? 1,
      top: request.top,
      latest: request.latest ?? false,
      exclude: request.exclude ?? [],
    }),
    timeoutMs: LONG_TIMEOUT_MS,
  });

  return {
    results: (data.results || []).map((item: any) => ({
      name: item.name,
      path: item.path,
      size: item.size,
      files: item.files,
      latest_mtime: item.latest_mtime,
      avg_file_size: item.avg_file_size,
    })),
    total_size: data.total_size || 0,
    total_files: data.total_files || 0,
    elapsed_seconds: data.elapsed_seconds || 0,
  };
}

/**
 * Stream du-hast-much results via SSE, calling onResult for each directory as it completes.
 * Returns final summary when the scan finishes.
 */
export function streamDuHastMuch(
  request: DuHastMuchRequest,
  onResult: (result: DuHastMuchResult) => void,
  signal?: AbortSignal
): Promise<{ totalSize: number; totalFiles: number; elapsedSeconds: number }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      path: request.path,
      depth: String(request.depth ?? 1),
      latest: String(request.latest ?? false),
    });
    if (request.top != null) params.set("top", String(request.top));
    if (request.exclude?.length) params.set("exclude", request.exclude.join(","));

    const url = `${API_ENDPOINT}/du-hast-much/stream?${params}`;
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event_type === "result") {
          onResult({
            name: data.name,
            path: data.path,
            size: data.size,
            files: data.files,
            latest_mtime: data.latest_mtime,
            avg_file_size: data.avg_file_size,
          });
        } else if (data.event_type === "done") {
          eventSource.close();
          resolve({
            totalSize: data.total_size || 0,
            totalFiles: data.total_files || 0,
            elapsedSeconds: data.elapsed_seconds || 0,
          });
        }
      } catch {
        eventSource.close();
        reject(new Error("Failed to parse du-hast-much stream event"));
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      reject(new Error("du-hast-much stream connection failed"));
    };

    if (signal) {
      signal.addEventListener("abort", () => {
        eventSource.close();
        reject(new Error("Scan cancelled"));
      });
    }
  });
}

/**
 * Get stored du-hast-much history from localStorage.
 */
export function getDuHastMuchHistory(): DuHastMuchResponse[] {
  try {
    const stored = localStorage.getItem("du-hast-much-history");
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Save du-hast-much result to history.
 */
export function saveDuHastMuchToHistory(result: DuHastMuchResponse): void {
  try {
    const history = getDuHastMuchHistory();
    // Keep only last 10 scans
    const updated = [result, ...history].slice(0, 10);
    localStorage.setItem("du-hast-much-history", JSON.stringify(updated));
  } catch (err) {
    console.error("Failed to save du-hast-much history:", err);
  }
}

/**
 * Clear du-hast-much history.
 */
export function clearDuHastMuchHistory(): void {
  try {
    localStorage.removeItem("du-hast-much-history");
  } catch (err) {
    console.error("Failed to clear du-hast-much history:", err);
  }
}
