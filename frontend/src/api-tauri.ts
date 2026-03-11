/**
 * Tauri API client for Disk Intelligence backend.
 * Handles all IPC communication with the Rust backend via Tauri commands.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ============================================================================
// Configuration
// ============================================================================

// Note: In Tauri, we don't need a base URL since we're using direct IPC
// The security validation happens in the Rust backend

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
  snapshotType: "scan" | "comparison";
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
  targetPath?: string;
  comparison?: ComparisonItem[];
  comparisonSummary?: ComparisonSummary;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Start a disk scan for the given root path.
 * @param rootPath - The root directory path to scan.
 * @returns A ScanResponse with scan_id and metadata.
 */
export async function scan(rootPath: string): Promise<ScanResponse> {
  const result = await invoke<any>('scan_directory', { rootPath: rootPath });
  return {
    scanId: result.scan_id,
    rootPath: result.root_path,
    startedAt: result.started_at,
    completedAt: result.completed_at,
    totalFiles: result.total_files,
    totalFolders: result.total_folders,
    totalSizeBytes: result.total_size_bytes,
  };
}

/**
 * Start a disk scan with real-time progress updates via Tauri events.
 * @param rootPath - The root directory path to scan.
 * @param onProgress - Callback for progress updates.
 * @returns A ScanResponse with scan_id and metadata.
 */
export async function scanWithProgress(
  rootPath: string,
  onProgress: (event: ProgressEventData) => void,
): Promise<ScanResponse> {
  // Set up event listener for progress updates
  const unlisten = await listen<ProgressEventData>('scan-progress', (event) => {
    onProgress(event.payload);
  });

  try {
    const result = await invoke<any>('scan_directory_with_progress', { rootPath: rootPath });

    return {
      scanId: result.scan_id,
      rootPath: result.root_path,
      startedAt: result.started_at,
      completedAt: result.completed_at,
      totalFiles: result.total_files,
      totalFolders: result.total_folders,
      totalSizeBytes: result.total_size_bytes,
    };
  } finally {
    // Clean up event listener
    unlisten();
  }
}

/**
 * Fetch findings for a completed scan.
 * @param scanId - The scan ID to fetch findings for.
 * @returns An array of Finding objects.
 */
export async function getFindings(scanId: string): Promise<Finding[]> {
  const result = await invoke<any[]>('get_findings', { scanId: scanId });
  return result.map((item: any) => ({
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
  scanId: string,
): Promise<ExtensionSummary[]> {
  const result = await invoke<any[]>('get_extension_summary', { scanId: scanId });
  return result.map((item: any) => ({
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
  return invoke<{ status: string }>('health_check');
}

/**
 * Save a snapshot of scan results.
 * @param scanId - The scan ID to save a snapshot of.
 * @param rootPath - The root path of scan.
 * @param scanInfo - The scan info from the completed scan.
 * @returns The saved snapshot.
 */
export async function saveSnapshot(
  scanId: string,
  rootPath: string,
  scanInfo?: ScanResponse,
): Promise<Snapshot> {
  // Get findings and extensions for this scan
  const [findingsData, extensionsData] = await Promise.all([
    getFindings(scanId),
    getExtensionSummary(scanId),
  ]);

  const result = await invoke<any>('save_snapshot', {
    scanId: scanId,
    rootPath: rootPath,
    findings: findingsData,
    extensions: extensionsData,
    scanInfo: scanInfo,
  });

  return transformSnapshot(result);
}

/**
 * Get DuHastMuch scan history from localStorage.
 */
export function getDuHastMuchHistory(): any[] {
  try {
    const history = localStorage.getItem('duHastMuchHistory');
    return history ? JSON.parse(history) : [];
  } catch (err) {
    console.error('[DuHastMuch] Failed to load history:', err);
    return [];
  }
}

/**
 * Save DuHastMuch scan to localStorage history.
 */
export function saveDuHastMuchToHistory(result: any): void {
  try {
    const history = getDuHastMuchHistory();
    const newHistory = [result, ...history].slice(0, 50); // Keep last 50 scans
    localStorage.setItem('duHastMuchHistory', JSON.stringify(newHistory));
  } catch (err) {
    console.error('[DuHastMuch] Failed to save to history:', err);
  }
}

/**
 * Run DuHastMuch analysis (not yet implemented in Tauri backend).
 */
export async function runDuHastMuch(_params: any): Promise<any> {
  // This is not yet implemented in the Rust backend
  // For now, return a placeholder
  return {
    results: [],
    totalSize: 0,
    totalFiles: 0,
    elapsedSeconds: 0,
  };
}

/**
 * Transform raw snapshot data from backend to frontend format
 */
function transformSnapshot(item: any): Snapshot {
  return {
    id: item.id,
    scanId: item.scan_id,
    rootPath: item.root_path,
    findings: (item.findings || []).map((f: any) => ({
      id: f.id,
      category: f.category,
      reason: f.reason,
      paths: f.paths || [],
      totalBytes: f.total_bytes || f.totalBytes || 0,
    })),
    extensions: (item.extensions || []).map((e: any) => ({
      extension: e.extension,
      fileCount: e.file_count || e.fileCount || 0,
      totalBytes: e.total_bytes || e.totalBytes || 0,
    })),
    scanInfo: {
      scanId: item.scan_info?.scan_id || item.scanId,
      rootPath: item.scan_info?.root_path || item.rootPath,
      startedAt: item.scan_info?.started_at || item.startedAt,
      completedAt: item.scan_info?.completed_at || item.completedAt,
      totalFiles: item.scan_info?.total_files || item.total_files || item.totalFiles || 0,
      totalFolders: item.scan_info?.total_folders || item.total_folders || item.totalFolders || 0,
      totalSizeBytes: item.scan_info?.total_size_bytes || item.total_size_bytes || item.totalSizeBytes || 0,
    },
    savedAt: item.saved_at,
    totalFiles: item.total_files || item.totalFiles || 0,
    totalFolders: item.total_folders || item.totalFolders || 0,
    totalSizeBytes: item.total_size_bytes || item.totalSizeBytes || 0,
    snapshotType: (item.snapshot_type || "scan") as "scan" | "comparison",
  };
}

/**
 * Get all saved snapshots.
 * @returns An array of snapshots.
 */
export async function getSnapshots(): Promise<ComparisonSnapshot[]> {
  const result = await invoke<any[]>('get_snapshots');
  return result.map((item: any) => transformComparisonSnapshot(item));
}

/**
 * Get a specific snapshot by ID.
 * @param snapshotId - The ID of the snapshot to retrieve.
 * @returns The snapshot data.
 */
export async function getSnapshot(snapshotId: string): Promise<Snapshot> {
  const result = await invoke<any>('get_snapshot', { snapshotId: snapshotId });
  return transformSnapshot(result);
}

/**
 * Update a snapshot by re-scanning its path.
 * @param snapshotId - The ID of the snapshot to update.
 * @returns The updated snapshot.
 */
export async function updateSnapshot(snapshotId: string): Promise<Snapshot> {
  const result = await invoke<any>('update_snapshot', { snapshotId: snapshotId });
  return transformSnapshot(result);
}

/**
 * Delete a snapshot.
 * @param snapshotId - The ID of the snapshot to delete.
 * @returns A success message.
 */
export async function deleteSnapshot(
  snapshotId: string,
): Promise<{ message: string }> {
  return invoke<{ message: string }>('delete_snapshot', { snapshotId: snapshotId });
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
  deepScan: boolean = false,
): Promise<ComparisonResponse> {
  const data = await invoke<any>('compare_directories', {
    sourcePath: sourcePath,
    targetPath: targetPath,
    deepScan: deepScan,
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
  comparisonId: string,
): Promise<ComparisonSnapshot> {
  const item = await invoke<any>('save_comparison_snapshot', {
    sourcePath: sourcePath,
    targetPath: targetPath,
    comparisonId: comparisonId,
  });

  return transformComparisonSnapshot(item);
}

/**
 * Update a comparison snapshot by re-running the comparison.
 */
export async function updateComparisonSnapshot(
  snapshotId: string,
): Promise<ComparisonSnapshot> {
  const item = await invoke<any>('update_comparison_snapshot', {
    snapshotId: snapshotId,
  });

  return transformComparisonSnapshot(item);
}

// ============================================================================
// Transform functions
// ============================================================================

/**
 * Transform snake_case ComparisonItem to camelCase (recursive)
 */
function transformComparisonItem(item: any): ComparisonItem {
  return {
    name: item.name,
    relativePath: item.relative_path || item.relativePath,
    itemType: item.item_type || item.itemType,
    status: item.status,
    sourceSize: item.source_size || item.sourceSize,
    targetSize: item.target_size || item.targetSize,
    sourceModified: item.source_modified || item.sourceModified,
    targetModified: item.target_modified || item.targetModified,
    sourceHash: item.source_hash || item.sourceHash,
    targetHash: item.target_hash || item.targetHash,
    children: item.children?.map(transformComparisonItem) || null,
    differenceCount: item.difference_count || item.differenceCount || 0,
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
function transformComparisonSnapshot(item: any): ComparisonSnapshot {
  const base: ComparisonSnapshot = {
    ...transformSnapshot(item),
    snapshotType: item.snapshot_type || item.snapshotType || "scan",
    targetPath: item.target_path || item.targetPath,
  };

  if (item.comparison) {
    base.comparison = item.comparison.map(transformComparisonItem);
  }
  if (item.comparison_summary) {
    base.comparisonSummary = transformComparisonSummary(item.comparison_summary);
  }

  return base;
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
// Dialog functions
// ============================================================================

/**
 * Open native directory selection dialog
 */
export async function selectDirectory(): Promise<string | null> {
  try {
    const result = await invoke<string | null>('select_directory');
    return result;
  } catch (error) {
    console.error('Failed to select directory:', error);
    return null;
  }
}