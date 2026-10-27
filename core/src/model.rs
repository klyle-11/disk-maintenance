//! Wire types. Field names match the FastAPI backend's JSON exactly.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScanResponse {
    pub scan_id: String,
    pub root_path: String,
    pub started_at: String,
    pub completed_at: String,
    pub total_files: u64,
    pub total_folders: u64,
    pub total_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Finding {
    pub id: String,
    pub category: String,
    pub reason: String,
    pub paths: Vec<String>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExtensionSummary {
    pub extension: String,
    pub file_count: u64,
    pub total_bytes: u64,
}

/// One progress tick of a running scan (`event_type` is always "progress").
#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub scan_id: String,
    pub event_type: &'static str,
    pub files_scanned: u64,
    pub folders_scanned: u64,
    pub bytes_scanned: u64,
    pub current_path: String,
    pub progress_percent: u32,
    pub elapsed_seconds: f64,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComparisonStatus {
    Identical,
    Modified,
    MissingFromTarget,
    ExtraInTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComparisonItem {
    pub name: String,
    pub relative_path: String,
    /// "file" or "folder"
    pub item_type: String,
    pub status: ComparisonStatus,
    pub source_size: Option<u64>,
    pub target_size: Option<u64>,
    pub source_modified: Option<String>,
    pub target_modified: Option<String>,
    pub source_hash: Option<String>,
    pub target_hash: Option<String>,
    pub children: Option<Vec<ComparisonItem>>,
    pub difference_count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ComparisonSummary {
    pub identical: u64,
    pub modified: u64,
    pub missing_from_target: u64,
    pub extra_in_target: u64,
    pub total_source_size: u64,
    pub total_target_size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComparisonResponse {
    pub comparison_id: String,
    pub source_path: String,
    pub target_path: String,
    pub summary: ComparisonSummary,
    pub tree: Vec<ComparisonItem>,
    pub deep_scan: bool,
    pub completed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DuHastMuchResult {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub files: u64,
    pub latest_mtime: f64,
    pub avg_file_size: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DuHastMuchRequest {
    pub path: String,
    #[serde(default)]
    pub top: Option<usize>,
    #[serde(default)]
    pub latest: bool,
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DuHastMuchResponse {
    pub results: Vec<DuHastMuchResult>,
    pub total_size: u64,
    pub total_files: u64,
    pub elapsed_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DuHastMuchDone {
    pub total_size: u64,
    pub total_files: u64,
    pub elapsed_seconds: f64,
}

/// A saved snapshot, as the API returns it.
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub id: String,
    pub scan_id: String,
    pub root_path: String,
    pub findings: serde_json::Value,
    pub extensions: serde_json::Value,
    pub scan_info: serde_json::Value,
    pub saved_at: String,
    pub total_files: Option<i64>,
    pub total_folders: Option<i64>,
    pub total_size_bytes: Option<i64>,
    pub snapshot_type: String,
    pub target_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparison: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparison_summary: Option<serde_json::Value>,
}
