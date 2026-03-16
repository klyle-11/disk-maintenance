// Scanner module for Disk Intelligence
// Handles file scanning and directory comparison operations

use crate::models::*;
use tauri::AppHandle;
use anyhow::Result;
use walkdir::WalkDir;
use std::path::Path;
use std::collections::HashMap;
use std::time::{UNIX_EPOCH};
use ignore::Walk;
use std::fs;
use chrono::Utc;
use std::sync::Arc;
use tokio::sync::Mutex;

// In-memory storage for scan results
lazy_static::lazy_static! {
    static ref SCAN_RESULTS: Mutex<HashMap<String, (Vec<Finding>, Vec<ExtensionSummary>)>> = Mutex::new(HashMap::new());
}

// Store scan results for later retrieval
pub async fn store_scan_results(scan_id: &str, findings: Vec<Finding>, extensions: Vec<ExtensionSummary>) {
    let mut results = SCAN_RESULTS.lock().await;
    results.insert(scan_id.to_string(), (findings, extensions));
}

// Retrieve scan results
pub async fn get_scan_results(scan_id: &str) -> Option<(Vec<Finding>, Vec<ExtensionSummary>)> {
    let results = SCAN_RESULTS.lock().await;
    results.get(scan_id).cloned()
}

// ============================================================================
// Scan Types
// ============================================================================

pub struct ScanResult {
    pub scan_id: String,
    pub root_path: String,
    pub total_files: i32,
    pub total_folders: i32,
    pub total_size_bytes: i64,
    pub findings: Vec<Finding>,
    pub extensions: Vec<ExtensionSummary>,
}

#[derive(serde::Serialize)]
pub struct ProgressEvent {
    pub scan_id: String,
    pub event_type: String,
    pub files_scanned: i32,
    pub folders_scanned: i32,
    pub bytes_scanned: i64,
    pub current_path: String,
    pub progress_percent: f64,
    pub elapsed_seconds: f64,
    pub message: String,
}

// ============================================================================
// File Categorization
// ============================================================================

struct FileCategorizer {
    temp_files: Vec<String>,
    large_files: Vec<String>,
    duplicates: HashMap<u64, Vec<String>>, // hash -> files
    cache_folders: Vec<String>,
    old_files: Vec<String>,
    system_junk: Vec<String>,
    extension_counts: HashMap<String, (i32, i64)>, // extension -> (count, total_bytes)
}

impl FileCategorizer {
    fn new() -> Self {
        Self {
            temp_files: Vec::new(),
            large_files: Vec::new(),
            duplicates: HashMap::new(),
            cache_folders: Vec::new(),
            old_files: Vec::new(),
            system_junk: Vec::new(),
            extension_counts: HashMap::new(),
        }
    }

    fn is_temp_file(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        path_str.contains(".tmp") ||
        path_str.contains(".temp") ||
        path_str.contains("~") ||
        path_str.contains(".cache") ||
        path_str.contains("/tmp/") ||
        path_str.contains("\\temp\\")
    }

    fn is_cache_folder(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        path_str.contains("cache") ||
        path_str.contains(".cache") ||
        path_str.contains("caches") ||
        path_str.contains("cachedata")
    }

    fn is_system_junk(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        path_str.contains(".ds_store") ||
        path_str.contains("thumbs.db") ||
        path_str.contains(".spotlight") ||
        path_str.contains(".trash") ||
        path_str.contains("recycle.bin")
    }

    fn is_old_file(&self, path: &Path, modified_secs: i64) -> bool {
        let one_year_ago = Utc::now().timestamp() - (365 * 24 * 60 * 60);
        modified_secs < one_year_ago
    }

    fn add_file(&mut self, path: &Path, size: u64, modified_secs: i64) {
        // Track extensions
        if let Some(ext) = path.extension() {
            let ext_str = ext.to_string_lossy().to_string();
            let entry = self.extension_counts.entry(ext_str.clone()).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += size as i64;
        }

        // Categorize files
        if self.is_temp_file(path) {
            self.temp_files.push(path.to_string_lossy().to_string());
        }

        if size > 100 * 1024 * 1024 { // 100MB
            self.large_files.push(path.to_string_lossy().to_string());
        }

        if self.is_system_junk(path) {
            self.system_junk.push(path.to_string_lossy().to_string());
        }

        if self.is_old_file(path, modified_secs) {
            self.old_files.push(path.to_string_lossy().to_string());
        }
    }

    fn generate_findings(&self) -> Vec<Finding> {
        let mut findings = Vec::new();

        if !self.temp_files.is_empty() {
            findings.push(Finding {
                id: uuid::Uuid::new_v4().to_string(),
                category: "temp_files".to_string(),
                reason: "Temporary files that can be safely deleted".to_string(),
                paths: self.temp_files.clone(),
                total_bytes: self.temp_files.iter().map(|p| {
                    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
                }).sum::<u64>() as i64,
            });
        }

        if !self.large_files.is_empty() {
            findings.push(Finding {
                id: uuid::Uuid::new_v4().to_string(),
                category: "large_files".to_string(),
                reason: "Files larger than 100MB".to_string(),
                paths: self.large_files.clone(),
                total_bytes: self.large_files.iter().map(|p| {
                    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
                }).sum::<u64>() as i64,
            });
        }

        if !self.system_junk.is_empty() {
            findings.push(Finding {
                id: uuid::Uuid::new_v4().to_string(),
                category: "system_junk".to_string(),
                reason: "System junk files that can be removed".to_string(),
                paths: self.system_junk.clone(),
                total_bytes: self.system_junk.iter().map(|p| {
                    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
                }).sum::<u64>() as i64,
            });
        }

        if !self.old_files.is_empty() {
            findings.push(Finding {
                id: uuid::Uuid::new_v4().to_string(),
                category: "old_files".to_string(),
                reason: "Files not modified in over a year".to_string(),
                paths: self.old_files.clone(),
                total_bytes: self.old_files.iter().map(|p| {
                    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
                }).sum::<u64>() as i64,
            });
        }

        findings
    }

    fn generate_extension_summary(&self) -> Vec<ExtensionSummary> {
        self.extension_counts.iter()
            .map(|(ext, (count, bytes))| {
                ExtensionSummary {
                    extension: ext.clone(),
                    file_count: *count,
                    total_bytes: *bytes,
                }
            })
            .collect()
    }
}

// ============================================================================
// Scan Functions
// ============================================================================

pub async fn perform_scan(
    app: &AppHandle,
    scan_id: &str,
    root_path: &str,
) -> Result<ScanResult> {
    let start_time = std::time::Instant::now();
    let mut categorizer = FileCategorizer::new();
    let mut total_files = 0;
    let mut total_folders = 0;
    let mut total_size_bytes = 0i64;

    let root = Path::new(root_path);
    if !root.exists() {
        return Err(anyhow::anyhow!("Path does not exist: {}", root_path));
    }

    // Walk the directory tree
    let walker = WalkDir::new(root_path)
        .follow_links(false);

    for entry in walker.into_iter().filter_map(|e| e.ok()) {
        let file_type = entry.file_type();

        if file_type.is_dir() {
            total_folders += 1;
            if categorizer.is_cache_folder(entry.path()) {
                categorizer.cache_folders.push(entry.path().to_string_lossy().to_string());
            }
        } else if file_type.is_file() {
            total_files += 1;

            // Get file metadata
            if let Ok(metadata) = entry.metadata() {
                let size = metadata.len();
                let modified = metadata.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                total_size_bytes += size as i64;
                categorizer.add_file(entry.path(), size, modified);
            }
        }
    }

    let elapsed = start_time.elapsed().as_secs_f64();

    Ok(ScanResult {
        scan_id: scan_id.to_string(),
        root_path: root_path.to_string(),
        total_files,
        total_folders,
        total_size_bytes,
        findings: categorizer.generate_findings(),
        extensions: categorizer.generate_extension_summary(),
    })
}

pub async fn perform_scan_with_progress<F>(
    app: &AppHandle,
    scan_id: &str,
    root_path: &str,
    progress_callback: F,
) -> Result<ScanResult>
where
    F: Fn(ProgressEvent),
{
    let start_time = std::time::Instant::now();
    let mut categorizer = FileCategorizer::new();
    let mut total_files = 0;
    let mut total_folders = 0;
    let mut total_size_bytes = 0i64;

    let root = Path::new(root_path);
    if !root.exists() {
        return Err(anyhow::anyhow!("Path does not exist: {}", root_path));
    }

    let walker = Walk::new(root_path);
    let mut last_emit = std::time::Instant::now();

    for entry in walker.flatten() {
        let path = entry.path();
        let file_type = entry.file_type();

        if let Some(ft) = file_type {
            if ft.is_dir() {
                total_folders += 1;
                if categorizer.is_cache_folder(path) {
                    categorizer.cache_folders.push(path.to_string_lossy().to_string());
                }
            } else if ft.is_file() {
            total_files += 1;

            if let Ok(metadata) = fs::metadata(path) {
                let size = metadata.len();
                let modified = metadata.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                total_size_bytes += size as i64;
                categorizer.add_file(path, size, modified);

                // Emit progress every 100 files or 1 second
                if total_files % 100 == 0 || last_emit.elapsed().as_secs() >= 1 {
                    let elapsed = start_time.elapsed().as_secs_f64();
                    progress_callback(ProgressEvent {
                        scan_id: scan_id.to_string(),
                        event_type: "progress".to_string(),
                        files_scanned: total_files,
                        folders_scanned: total_folders,
                        bytes_scanned: total_size_bytes,
                        current_path: path.to_string_lossy().to_string(),
                        progress_percent: (total_files as f64 / ((total_files + 1) as f64)) * 100.0,
                        elapsed_seconds: elapsed,
                        message: format!("Scanned {} files, {} folders", total_files, total_folders),
                    });
                    last_emit = std::time::Instant::now();
                }
            }
        }
        }
    }

    // Final progress event
    let elapsed = start_time.elapsed().as_secs_f64();
    progress_callback(ProgressEvent {
        scan_id: scan_id.to_string(),
        event_type: "complete".to_string(),
        files_scanned: total_files,
        folders_scanned: total_folders,
        bytes_scanned: total_size_bytes,
        current_path: root_path.to_string(),
        progress_percent: 100.0,
        elapsed_seconds: elapsed,
        message: format!("Scan complete: {} files, {} folders", total_files, total_folders),
    });

    Ok(ScanResult {
        scan_id: scan_id.to_string(),
        root_path: root_path.to_string(),
        total_files,
        total_folders,
        total_size_bytes,
        findings: categorizer.generate_findings(),
        extensions: categorizer.generate_extension_summary(),
    })
}

// ============================================================================
// Comparison Functions
// ============================================================================

pub async fn perform_comparison(
    app: &AppHandle,
    comparison_id: &str,
    source_path: &str,
    target_path: &str,
    deep_scan: bool,
) -> Result<ComparisonResult> {
    use chrono::Utc;

    // Placeholder implementation
    // This will be fully implemented in the scanner task

    Ok(ComparisonResult {
        comparison_id: comparison_id.to_string(),
        source_path: source_path.to_string(),
        target_path: target_path.to_string(),
        summary: ComparisonSummary {
            identical: 0,
            modified: 0,
            missing_from_target: 0,
            extra_in_target: 0,
            total_source_size: 0,
            total_target_size: 0,
        },
        tree: vec![],
        deep_scan,
        completed_at: Utc::now().to_rfc3339(),
    })
}// Scanner module for Disk Intelligence
// Handles file scanning and directory comparison operations

use crate::models::*;
use tauri::AppHandle;
use anyhow::Result;
use walkdir::WalkDir;
use std::path::Path;
use std::collections::HashMap;
use std::time::{UNIX_EPOCH};
use ignore::Walk;
use std::fs;
use chrono::Utc;
use tokio::sync::Mutex;

// In-memory storage for scan results
lazy_static::lazy_static! {
    static ref SCAN_RESULTS: Mutex<HashMap<String, (Vec<Finding>, Vec<ExtensionSummary>)>> = Mutex::new(HashMap::new());
}

// Store scan results for later retrieval
pub async fn store_scan_results(scan_id: &str, findings: Vec<Finding>, extensions: Vec<ExtensionSummary>) {
    let mut results = SCAN_RESULTS.lock().await;
    results.insert(scan_id.to_string(), (findings, extensions));
}

// Retrieve scan results
pub async fn get_scan_results(scan_id: &str) -> Option<(Vec<Finding>, Vec<ExtensionSummary>)> {
    let results = SCAN_RESULTS.lock().await;
    results.get(scan_id).cloned()
}

// ============================================================================
// Scan Types
// ============================================================================

pub struct ScanResult {
    pub scan_id: String,
    pub root_path: String,
    pub total_files: i32,
    pub total_folders: i32,
    pub total_size_bytes: i64,
    pub findings: Vec<Finding>,
    pub extensions: Vec<ExtensionSummary>,
}

#[derive(serde::Serialize)]
pub struct ProgressEvent {
    pub scan_id: String,
    pub event_type: String,
    pub files_scanned: i32,
    pub folders_scanned: i32,
    pub bytes_scanned: i64,
    pub current_path: String,
    pub progress_percent: f64,
    pub elapsed_seconds: f64,
    pub message: String,
}

// ============================================================================
// File Categorization
// ============================================================================

struct FileCategorizer {
    temp_files: Vec<String>,
    large_files: Vec<String>,
    _duplicates: HashMap<u64, Vec<String>>, // hash -> files (reserved for future use)
    cache_folders: Vec<String>,
    old_files: Vec<String>,
    system_junk: Vec<String>,
    extension_counts: HashMap<String, (i32, i64)>, // extension -> (count, total_bytes)
}

impl FileCategorizer {
    fn new() -> Self {
        Self {
            temp_files: Vec::new(),
            large_files: Vec::new(),
            _duplicates: HashMap::new(),
            cache_folders: Vec::new(),
            old_files: Vec::new(),
            system_junk: Vec::new(),
            extension_counts: HashMap::new(),
        }
    }

    fn is_temp_file(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        path_str.contains(".tmp") ||
        path_str.contains(".temp") ||
        path_str.contains("~") ||
        path_str.contains(".cache") ||
        path_str.contains("/tmp/") ||
        path_str.contains("\\temp\\")
    }

    fn is_cache_folder(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        path_str.contains("cache") ||
        path_str.contains(".cache") ||
        path_str.contains("caches") ||
        path_str.contains("cachedata")
    }

    fn is_system_junk(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        path_str.contains(".ds_store") ||
        path_str.contains("thumbs.db") ||
        path_str.contains(".spotlight") ||
        path_str.contains(".trash") ||
        path_str.contains("recycle.bin")
    }

    fn is_old_file(&self, _path: &Path, modified_secs: i64) -> bool {
        let one_year_ago = Utc::now().timestamp() - (365 * 24 * 60 * 60);
        modified_secs < one_year_ago
    }

    fn add_file(&mut self, path: &Path, size: u64, modified_secs: i64) {
        // Track extensions
        if let Some(ext) = path.extension() {
            let ext_str = ext.to_string_lossy().to_string();
            let entry = self.extension_counts.entry(ext_str.clone()).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += size as i64;
        }

        // Categorize files
        if self.is_temp_file(path) {
            self.temp_files.push(path.to_string_lossy().to_string());
        }

        if size > 100 * 1024 * 1024 { // 100MB
            self.large_files.push(path.to_string_lossy().to_string());
        }

        if self.is_system_junk(path) {
            self.system_junk.push(path.to_string_lossy().to_string());
        }

        if self.is_old_file(path, modified_secs) {
            self.old_files.push(path.to_string_lossy().to_string());
        }
    }

    fn generate_findings(&self) -> Vec<Finding> {
        let mut findings = Vec::new();

        if !self.temp_files.is_empty() {
            findings.push(Finding {
                id: uuid::Uuid::new_v4().to_string(),
                category: "temp_files".to_string(),
                reason: "Temporary files that can be safely deleted".to_string(),
                paths: self.temp_files.clone(),
                total_bytes: self.temp_files.iter().map(|p| {
                    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
                }).sum::<u64>() as i64,
            });
        }

        if !self.large_files.is_empty() {
            findings.push(Finding {
                id: uuid::Uuid::new_v4().to_string(),
                category: "large_files".to_string(),
                reason: "Files larger than 100MB".to_string(),
                paths: self.large_files.clone(),
                total_bytes: self.large_files.iter().map(|p| {
                    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
                }).sum::<u64>() as i64,
            });
        }

        if !self.system_junk.is_empty() {
            findings.push(Finding {
                id: uuid::Uuid::new_v4().to_string(),
                category: "system_junk".to_string(),
                reason: "System junk files that can be removed".to_string(),
                paths: self.system_junk.clone(),
                total_bytes: self.system_junk.iter().map(|p| {
                    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
                }).sum::<u64>() as i64,
            });
        }

        if !self.old_files.is_empty() {
            findings.push(Finding {
                id: uuid::Uuid::new_v4().to_string(),
                category: "old_files".to_string(),
                reason: "Files not modified in over a year".to_string(),
                paths: self.old_files.clone(),
                total_bytes: self.old_files.iter().map(|p| {
                    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
                }).sum::<u64>() as i64,
            });
        }

        findings
    }

    fn generate_extension_summary(&self) -> Vec<ExtensionSummary> {
        self.extension_counts.iter()
            .map(|(ext, (count, bytes))| {
                ExtensionSummary {
                    extension: ext.clone(),
                    file_count: *count,
                    total_bytes: *bytes,
                }
            })
            .collect()
    }
}

// ============================================================================
// Scan Functions
// ============================================================================

pub async fn perform_scan(
    _app: &AppHandle,
    scan_id: &str,
    root_path: &str,
) -> Result<ScanResult> {
    let start_time = std::time::Instant::now();
    let mut categorizer = FileCategorizer::new();
    let mut total_files = 0;
    let mut total_folders = 0;
    let mut total_size_bytes = 0i64;

    let root = Path::new(root_path);
    if !root.exists() {
        return Err(anyhow::anyhow!("Path does not exist: {}", root_path));
    }

    // Walk the directory tree
    let walker = WalkDir::new(root_path)
        .follow_links(false);

    for entry in walker.into_iter().filter_map(|e| e.ok()) {
        let file_type = entry.file_type();

        if file_type.is_dir() {
            total_folders += 1;
            if categorizer.is_cache_folder(entry.path()) {
                categorizer.cache_folders.push(entry.path().to_string_lossy().to_string());
            }
        } else if file_type.is_file() {
            total_files += 1;

            // Get file metadata
            if let Ok(metadata) = entry.metadata() {
                let size = metadata.len();
                let modified = metadata.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                total_size_bytes += size as i64;
                categorizer.add_file(entry.path(), size, modified);
            }
        }
    }

    let _elapsed = start_time.elapsed().as_secs_f64();

    Ok(ScanResult {
        scan_id: scan_id.to_string(),
        root_path: root_path.to_string(),
        total_files,
        total_folders,
        total_size_bytes,
        findings: categorizer.generate_findings(),
        extensions: categorizer.generate_extension_summary(),
    })
}

pub async fn perform_scan_with_progress<F>(
    _app: &AppHandle,
    scan_id: &str,
    root_path: &str,
    progress_callback: F,
) -> Result<ScanResult>
where
    F: Fn(ProgressEvent),
{
    let start_time = std::time::Instant::now();
    let mut categorizer = FileCategorizer::new();
    let mut total_files = 0;
    let mut total_folders = 0;
    let mut total_size_bytes = 0i64;

    let root = Path::new(root_path);
    if !root.exists() {
        return Err(anyhow::anyhow!("Path does not exist: {}", root_path));
    }

    let walker = Walk::new(root_path);
    let mut last_emit = std::time::Instant::now();

    for entry in walker.flatten() {
        let path = entry.path();
        let file_type = entry.file_type();

        if let Some(ft) = file_type {
            if ft.is_dir() {
                total_folders += 1;
                if categorizer.is_cache_folder(path) {
                    categorizer.cache_folders.push(path.to_string_lossy().to_string());
                }
            } else if ft.is_file() {
            total_files += 1;

            if let Ok(metadata) = fs::metadata(path) {
                let size = metadata.len();
                let modified = metadata.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                total_size_bytes += size as i64;
                categorizer.add_file(path, size, modified);

                // Emit progress every 100 files or 1 second
                if total_files % 100 == 0 || last_emit.elapsed().as_secs() >= 1 {
                    let elapsed = start_time.elapsed().as_secs_f64();
                    progress_callback(ProgressEvent {
                        scan_id: scan_id.to_string(),
                        event_type: "progress".to_string(),
                        files_scanned: total_files,
                        folders_scanned: total_folders,
                        bytes_scanned: total_size_bytes,
                        current_path: path.to_string_lossy().to_string(),
                        progress_percent: (total_files as f64 / ((total_files + 1) as f64)) * 100.0,
                        elapsed_seconds: elapsed,
                        message: format!("Scanned {} files, {} folders", total_files, total_folders),
                    });
                    last_emit = std::time::Instant::now();
                }
            }
        }
        }
    }

    // Final progress event
    let elapsed = start_time.elapsed().as_secs_f64();
    progress_callback(ProgressEvent {
        scan_id: scan_id.to_string(),
        event_type: "complete".to_string(),
        files_scanned: total_files,
        folders_scanned: total_folders,
        bytes_scanned: total_size_bytes,
        current_path: root_path.to_string(),
        progress_percent: 100.0,
        elapsed_seconds: elapsed,
        message: format!("Scan complete: {} files, {} folders", total_files, total_folders),
    });

    Ok(ScanResult {
        scan_id: scan_id.to_string(),
        root_path: root_path.to_string(),
        total_files,
        total_folders,
        total_size_bytes,
        findings: categorizer.generate_findings(),
        extensions: categorizer.generate_extension_summary(),
    })
}

// ============================================================================
// Comparison Functions
// ============================================================================

pub async fn perform_comparison(
    _app: &AppHandle,
    comparison_id: &str,
    source_path: &str,
    target_path: &str,
    deep_scan: bool,
) -> Result<ComparisonResult> {
    use chrono::Utc;

    // Placeholder implementation
    // This will be fully implemented in the scanner task

    Ok(ComparisonResult {
        comparison_id: comparison_id.to_string(),
        source_path: source_path.to_string(),
        target_path: target_path.to_string(),
        summary: ComparisonSummary {
            identical: 0,
            modified: 0,
            missing_from_target: 0,
            extra_in_target: 0,
            total_source_size: 0,
            total_target_size: 0,
        },
        tree: vec![],
        deep_scan,
        completed_at: Utc::now().to_rfc3339(),
    })
}