// Repository module for database operations
// Provides CRUD operations for snapshots

use diesel::prelude::*;
use crate::models::{Snapshot, NewSnapshot, SnapshotData};
use crate::database::establish_connection;
use tauri::AppHandle;
use anyhow::Result;
use serde_json;

use crate::models::snapshots::dsl::*;

// Get all snapshots
pub fn get_all_snapshots(app: &AppHandle) -> Result<Vec<SnapshotData>> {
    let mut conn = establish_connection(app)?;
    let results = snapshots
        .load::<Snapshot>(&mut conn)?;

    results.into_iter()
        .map(|s| convert_snapshot_to_data(s))
        .collect()
}

// Get a specific snapshot by ID
pub fn get_snapshot_by_id(app: &AppHandle, snapshot_id: &str) -> Result<SnapshotData> {
    let mut conn = establish_connection(app)?;
    let snapshot = snapshots
        .filter(id.eq(snapshot_id))
        .first::<Snapshot>(&mut conn)?;

    convert_snapshot_to_data(snapshot)
}

// Create a new snapshot
pub fn create_snapshot(
    app: &AppHandle,
    new_snapshot: NewSnapshot,
) -> Result<SnapshotData> {
    let mut conn = establish_connection(app)?;

    diesel::insert_into(snapshots)
        .values(&new_snapshot)
        .execute(&mut conn)?;

    get_snapshot_by_id(app, &new_snapshot.id)
}

// Update an existing snapshot
pub fn update_snapshot(
    app: &AppHandle,
    snapshot_id: &str,
    updated_snapshot: NewSnapshot,
) -> Result<SnapshotData> {
    let mut conn = establish_connection(app)?;

    diesel::update(snapshots.filter(id.eq(snapshot_id)))
        .set((
            findings_json.eq(&updated_snapshot.findings_json),
            extensions_json.eq(&updated_snapshot.extensions_json),
            scan_info_json.eq(&updated_snapshot.scan_info_json),
            total_files.eq(updated_snapshot.total_files),
            total_folders.eq(updated_snapshot.total_folders),
            total_size_bytes.eq(updated_snapshot.total_size_bytes),
        ))
        .execute(&mut conn)?;

    get_snapshot_by_id(app, snapshot_id)
}

// Delete a snapshot
pub fn delete_snapshot(app: &AppHandle, snapshot_id: &str) -> Result<()> {
    let mut conn = establish_connection(app)?;

    diesel::delete(snapshots.filter(id.eq(snapshot_id)))
        .execute(&mut conn)?;

    Ok(())
}

// Convert database model to frontend-facing model
fn convert_snapshot_to_data(snapshot: Snapshot) -> Result<SnapshotData> {
    let findings: Vec<crate::models::Finding> = serde_json::from_str(&snapshot.findings_json)?;
    let extensions: Vec<crate::models::ExtensionSummary> = serde_json::from_str(&snapshot.extensions_json)?;
    let scan_info: crate::models::ScanInfo = serde_json::from_str(&snapshot.scan_info_json)?;

    let comparison = if let Some(ref comp_json) = snapshot.comparison_json {
        Some(serde_json::from_str(comp_json)?)
    } else {
        None
    };

    let comparison_summary = if let Some(ref summary_json) = snapshot.comparison_summary_json {
        Some(serde_json::from_str(summary_json)?)
    } else {
        None
    };

    Ok(SnapshotData {
        id: snapshot.id,
        scan_id: snapshot.scan_id,
        root_path: snapshot.root_path,
        findings,
        extensions,
        scan_info,
        saved_at: snapshot.saved_at,
        total_files: snapshot.total_files.unwrap_or(0),
        total_folders: snapshot.total_folders.unwrap_or(0),
        total_size_bytes: snapshot.total_size_bytes.unwrap_or(0),
        snapshot_type: snapshot.snapshot_type,
        target_path: snapshot.target_path,
        comparison,
        comparison_summary,
    })
}