// Tauri command handlers for Disk Intelligence
// Provides IPC interface for frontend operations

use crate::models::*;
use crate::repository::*;
use crate::scanner::*;
use tauri::{AppHandle, Emitter};
use anyhow::Result;

// ============================================================================
// Snapshot Commands
// ============================================================================

#[tauri::command]  
pub async fn get_snapshots(app: AppHandle) -> Result<Vec<SnapshotData>, String> {
    get_all_snapshots(&app)
        .map_err(|e| e.to_string())
}

#[tauri::command]  
pub async fn get_snapshot(app: AppHandle, snapshot_id: String) -> Result<SnapshotData, String> {
    get_snapshot_by_id(&app, &snapshot_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]  
pub async fn save_snapshot(
    app: AppHandle,
    scan_id: String,
    root_path: String,
    findings: Vec<Finding>,
    extensions: Vec<ExtensionSummary>,
    scan_info: ScanInfo,
) -> Result<SnapshotData, String> {
    use uuid::Uuid;
    use chrono::Utc;

    let snapshot_id = Uuid::new_v4().to_string();
    let saved_at = Utc::now().to_rfc3339();

    let new_snapshot = NewSnapshot {
        id: snapshot_id.clone(),
        scan_id,
        root_path,
        findings_json: serde_json::to_string(&findings).map_err(|e| e.to_string())?,
        extensions_json: serde_json::to_string(&extensions).map_err(|e| e.to_string())?,
        scan_info_json: serde_json::to_string(&scan_info).map_err(|e| e.to_string())?,
        saved_at,
        total_files: Some(scan_info.total_files),
        total_folders: Some(scan_info.total_folders),
        total_size_bytes: Some(scan_info.total_size_bytes as i32),
        snapshot_type: "scan".to_string(),
        target_path: None,
        comparison_json: None,
        comparison_summary_json: None,
    };

    create_snapshot(&app, new_snapshot)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_snapshot(_app: AppHandle, _snapshot_id: String) -> Result<SnapshotData, String> {
    // For now, this will require a re-scan
    // In future, we can implement incremental updates
    Err("Snapshot updates not yet implemented".to_string())
}

#[tauri::command]
pub async fn delete_snapshot(app: AppHandle, snapshot_id: String) -> Result<(), String> {
    crate::repository::delete_snapshot(&app, &snapshot_id)
        .map_err(|e| e.to_string())
}

// ============================================================================
// Scan Commands
// ============================================================================

#[tauri::command]
pub async fn scan_directory(
    app: AppHandle,
    root_path: String,
) -> Result<ScanInfo, String> {
    use uuid::Uuid;
    use chrono::Utc;

    let scan_id = Uuid::new_v4().to_string();
    let started_at = Utc::now().to_rfc3339();

    // Perform the scan
    let scan_result = perform_scan(&app, &scan_id, &root_path)
        .await
        .map_err(|e| e.to_string())?;

    // Store the results for later retrieval
    crate::scanner::store_scan_results(&scan_id, scan_result.findings.clone(), scan_result.extensions.clone()).await;

    let completed_at = Utc::now().to_rfc3339();

    Ok(ScanInfo {
        scan_id: scan_result.scan_id,
        root_path: scan_result.root_path,
        started_at,
        completed_at,
        total_files: scan_result.total_files,
        total_folders: scan_result.total_folders,
        total_size_bytes: scan_result.total_size_bytes,
    })
}

#[tauri::command]  
pub async fn scan_directory_with_progress(
    app: AppHandle,
    root_path: String,
) -> Result<ScanInfo, String> {
    use uuid::Uuid;
    use chrono::Utc;

    let scan_id = Uuid::new_v4().to_string();
    let started_at = Utc::now().to_rfc3339();

    // Perform scan with progress events
    let scan_result = perform_scan_with_progress(&app, &scan_id, &root_path, |progress| {
        let _ = app.emit("scan-progress", &progress);
    })
    .await
    .map_err(|e| e.to_string())?;

    let completed_at = Utc::now().to_rfc3339();

    Ok(ScanInfo {
        scan_id: scan_result.scan_id,
        root_path: scan_result.root_path,
        started_at,
        completed_at,
        total_files: scan_result.total_files,
        total_folders: scan_result.total_folders,
        total_size_bytes: scan_result.total_size_bytes,
    })
}

#[tauri::command]
pub async fn get_findings(
    _app: AppHandle,
    scan_id: String,
) -> Result<Vec<Finding>, String> {
    match crate::scanner::get_scan_results(&scan_id).await {
        Some((findings, _)) => Ok(findings),
        None => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn get_extension_summary(
    _app: AppHandle,
    scan_id: String,
) -> Result<Vec<ExtensionSummary>, String> {
    match crate::scanner::get_scan_results(&scan_id).await {
        Some((_, extensions)) => Ok(extensions),
        None => Ok(vec![]),
    }
}

// ============================================================================
// Comparison Commands
// ============================================================================

#[tauri::command]
pub async fn compare_directories(
    app: AppHandle,
    source_path: String,
    target_path: String,
    deep_scan: bool,
) -> Result<ComparisonResult, String> {
    use uuid::Uuid;

    let comparison_id = Uuid::new_v4().to_string();

    // Perform the comparison
    let comparison_result = perform_comparison(&app, &comparison_id, &source_path, &target_path, deep_scan)
        .await
        .map_err(|e| e.to_string())?;

    Ok(comparison_result)
}

#[tauri::command]
pub async fn save_comparison_snapshot(
    _app: AppHandle,
    _source_path: String,
    _target_path: String,
    _comparison_id: String,
) -> Result<SnapshotData, String> {
    // For now, return not implemented
    Err("Comparison snapshots not yet implemented".to_string())
}

// ============================================================================
// Health Check
// ============================================================================

#[tauri::command]  
pub async fn health_check() -> Result<HealthStatus, String> {
    Ok(HealthStatus {
        status: "healthy".to_string(),
        version: "0.1.0".to_string(),
    })
}

// ============================================================================
// Du-Hast-Much Commands
// ============================================================================

#[tauri::command]
pub async fn run_du_hast_much(
    _app: AppHandle,
    _path: String,
    _depth: Option<i32>,
    _top: Option<i32>,
    _latest: Option<bool>,
    _exclude: Option<Vec<String>>,
) -> Result<DuHastMuchResponse, String> {
    // For now, return not implemented
    Err("Du-hast-much not yet implemented".to_string())
}

// ============================================================================
// Dialog Commands (using Tauri plugin)
// ============================================================================

#[tauri::command]
pub async fn select_directory(_app: AppHandle) -> Result<Option<String>, String> {
    // This will use the tauri-plugin-dialog
    // For now, return a placeholder
    Ok(None)
}

// ============================================================================
// Utility Commands
// ============================================================================

#[tauri::command]  
pub async fn format_bytes(bytes: i64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    if bytes == 0 {
        return "0 B".to_string();
    }

    let bytes = bytes as f64;
    let unit_index = (bytes.log2() / 1024_f64.log2()).floor() as usize;
    let unit_index = unit_index.min(UNITS.len() - 1);
    let size = bytes / (1024_f64.powi(unit_index as i32));

    format!("{:.2} {}", size, UNITS[unit_index])
}
// Tauri command handlers for Disk Intelligence
// Provides IPC interface for frontend operations

use crate::models::*;
use crate::repository::*;
use crate::scanner::*;
use tauri::{AppHandle, Emitter};
use anyhow::Result;

// ============================================================================
// Snapshot Commands
// ============================================================================

#[tauri::command]  
pub async fn get_snapshots(app: AppHandle) -> Result<Vec<SnapshotData>, String> {
    get_all_snapshots(&app)
        .map_err(|e| e.to_string())
}

#[tauri::command]  
pub async fn get_snapshot(app: AppHandle, snapshot_id: String) -> Result<SnapshotData, String> {
    get_snapshot_by_id(&app, &snapshot_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]  
pub async fn save_snapshot(
    app: AppHandle,
    scan_id: String,
    root_path: String,
    findings: Vec<Finding>,
    extensions: Vec<ExtensionSummary>,
    scan_info: ScanInfo,
) -> Result<SnapshotData, String> {
    use uuid::Uuid;
    use chrono::Utc;

    let snapshot_id = Uuid::new_v4().to_string();
    let saved_at = Utc::now().to_rfc3339();

    let new_snapshot = NewSnapshot {
        id: snapshot_id.clone(),
        scan_id,
        root_path,
        findings_json: serde_json::to_string(&findings).map_err(|e| e.to_string())?,
        extensions_json: serde_json::to_string(&extensions).map_err(|e| e.to_string())?,
        scan_info_json: serde_json::to_string(&scan_info).map_err(|e| e.to_string())?,
        saved_at,
        total_files: Some(scan_info.total_files),
        total_folders: Some(scan_info.total_folders),
        total_size_bytes: Some(scan_info.total_size_bytes as i32),
        snapshot_type: "scan".to_string(),
        target_path: None,
        comparison_json: None,
        comparison_summary_json: None,
    };

    create_snapshot(&app, new_snapshot)
        .map_err(|e| e.to_string())
}

#[tauri::command]  
pub async fn update_snapshot(app: AppHandle, snapshot_id: String) -> Result<SnapshotData, String> {
    // For now, this will require a re-scan
    // In the future, we can implement incremental updates
    Err("Snapshot updates not yet implemented".to_string())
}

#[tauri::command]
pub async fn delete_snapshot(app: AppHandle, snapshot_id: String) -> Result<(), String> {
    crate::repository::delete_snapshot(&app, &snapshot_id)
        .map_err(|e| e.to_string())
}

// ============================================================================
// Scan Commands
// ============================================================================

#[tauri::command]
pub async fn scan_directory(
    app: AppHandle,
    root_path: String,
) -> Result<ScanInfo, String> {
    use uuid::Uuid;
    use chrono::Utc;

    let scan_id = Uuid::new_v4().to_string();
    let started_at = Utc::now().to_rfc3339();

    // Perform the scan
    let scan_result = perform_scan(&app, &scan_id, &root_path)
        .await
        .map_err(|e| e.to_string())?;

    // Store the results for later retrieval
    crate::scanner::store_scan_results(&scan_id, scan_result.findings.clone(), scan_result.extensions.clone()).await;

    let completed_at = Utc::now().to_rfc3339();

    Ok(ScanInfo {
        scan_id: scan_result.scan_id,
        root_path: scan_result.root_path,
        started_at,
        completed_at,
        total_files: scan_result.total_files,
        total_folders: scan_result.total_folders,
        total_size_bytes: scan_result.total_size_bytes,
    })
}

#[tauri::command]  
pub async fn scan_directory_with_progress(
    app: AppHandle,
    root_path: String,
) -> Result<ScanInfo, String> {
    use uuid::Uuid;
    use chrono::Utc;

    let scan_id = Uuid::new_v4().to_string();
    let started_at = Utc::now().to_rfc3339();

    // Perform scan with progress events
    let scan_result = perform_scan_with_progress(&app, &scan_id, &root_path, |progress| {
        let _ = app.emit("scan-progress", &progress);
    })
    .await
    .map_err(|e| e.to_string())?;

    let completed_at = Utc::now().to_rfc3339();

    Ok(ScanInfo {
        scan_id: scan_result.scan_id,
        root_path: scan_result.root_path,
        started_at,
        completed_at,
        total_files: scan_result.total_files,
        total_folders: scan_result.total_folders,
        total_size_bytes: scan_result.total_size_bytes,
    })
}

#[tauri::command]
pub async fn get_findings(
    app: AppHandle,
    scan_id: String,
) -> Result<Vec<Finding>, String> {
    match crate::scanner::get_scan_results(&scan_id).await {
        Some((findings, _)) => Ok(findings),
        None => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn get_extension_summary(
    app: AppHandle,
    scan_id: String,
) -> Result<Vec<ExtensionSummary>, String> {
    match crate::scanner::get_scan_results(&scan_id).await {
        Some((_, extensions)) => Ok(extensions),
        None => Ok(vec![]),
    }
}

// ============================================================================
// Comparison Commands
// ============================================================================

#[tauri::command]  
pub async fn compare_directories(
    app: AppHandle,
    source_path: String,
    target_path: String,
    deep_scan: bool,
) -> Result<ComparisonResult, String> {
    use uuid::Uuid;
    use chrono::Utc;

    let comparison_id = Uuid::new_v4().to_string();

    // Perform the comparison
    let comparison_result = perform_comparison(&app, &comparison_id, &source_path, &target_path, deep_scan)
        .await
        .map_err(|e| e.to_string())?;

    Ok(comparison_result)
}

#[tauri::command]  
pub async fn save_comparison_snapshot(
    app: AppHandle,
    source_path: String,
    target_path: String,
    comparison_id: String,
) -> Result<SnapshotData, String> {
    // For now, return not implemented
    Err("Comparison snapshots not yet implemented".to_string())
}

// ============================================================================
// Health Check
// ============================================================================

#[tauri::command]  
pub async fn health_check() -> Result<HealthStatus, String> {
    Ok(HealthStatus {
        status: "healthy".to_string(),
        version: "0.1.0".to_string(),
    })
}

// ============================================================================
// Du-Hast-Much Commands
// ============================================================================

#[tauri::command]  
pub async fn run_du_hast_much(
    app: AppHandle,
    path: String,
    depth: Option<i32>,
    top: Option<i32>,
    latest: Option<bool>,
    exclude: Option<Vec<String>>,
) -> Result<DuHastMuchResponse, String> {
    // For now, return not implemented
    Err("Du-hast-much not yet implemented".to_string())
}

// ============================================================================
// Dialog Commands (using Tauri plugin)
// ============================================================================

#[tauri::command]  
pub async fn select_directory(app: AppHandle) -> Result<Option<String>, String> {
    // This will use the tauri-plugin-dialog
    // For now, return a placeholder
    Ok(None)
}

// ============================================================================
// Utility Commands
// ============================================================================

#[tauri::command]  
pub async fn format_bytes(bytes: i64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    if bytes == 0 {
        return "0 B".to_string();
    }

    let bytes = bytes as f64;
    let unit_index = (bytes.log2() / 1024_f64.log2()).floor() as usize;
    let unit_index = unit_index.min(UNITS.len() - 1);
    let size = bytes / (1024_f64.powi(unit_index as i32));

    format!("{:.2} {}", size, UNITS[unit_index])
}