//! Saved snapshots (scans and comparisons), in the SQLite database the app has
//! always used, with the same table and JSON columns. Snapshots saved by the
//! earlier Python backend open here unchanged, and `di`'s baselines share the
//! file in their own table.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS snapshots (
    id VARCHAR NOT NULL PRIMARY KEY,
    scan_id VARCHAR NOT NULL,
    root_path VARCHAR NOT NULL,
    findings_json TEXT NOT NULL,
    extensions_json TEXT NOT NULL,
    scan_info_json TEXT NOT NULL,
    saved_at DATETIME,
    total_files INTEGER,
    total_folders INTEGER,
    total_size_bytes INTEGER,
    snapshot_type VARCHAR,
    target_path VARCHAR,
    comparison_json TEXT,
    comparison_summary_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_snapshots_id ON snapshots (id);
CREATE INDEX IF NOT EXISTS ix_snapshots_root_path ON snapshots (root_path);
";

/// Columns added after the first release (the Python backend added them the
/// same way).
const LATER_COLUMNS: &[(&str, &str)] = &[
    ("snapshot_type", "VARCHAR DEFAULT 'scan'"),
    ("target_path", "VARCHAR"),
    ("comparison_json", "TEXT"),
    ("comparison_summary_json", "TEXT"),
];

/// A snapshot as the app receives it (the same shape the HTTP API returned).
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotRecord {
    pub id: String,
    pub scan_id: String,
    pub root_path: String,
    pub findings: Value,
    pub extensions: Value,
    pub scan_info: Value,
    pub saved_at: String,
    pub total_files: Option<i64>,
    pub total_folders: Option<i64>,
    pub total_size_bytes: Option<i64>,
    pub snapshot_type: String,
    pub target_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparison: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparison_summary: Option<Value>,
}

/// What a new or refreshed snapshot holds.
pub struct SnapshotData<'a> {
    pub scan_id: &'a str,
    pub root_path: &'a str,
    pub findings: Value,
    pub extensions: Value,
    pub scan_info: Value,
    pub total_files: i64,
    pub total_folders: i64,
    pub total_size_bytes: i64,
    pub snapshot_type: &'a str,
    pub target_path: Option<&'a str>,
    pub comparison: Option<Value>,
    pub comparison_summary: Option<Value>,
}

pub struct Store {
    conn: Connection,
}

/// The time format SQLAlchemy wrote (naive UTC).
fn utc_now() -> String {
    chrono::Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

fn parse_json(text: Option<String>) -> Option<Value> {
    text.and_then(|t| serde_json::from_str(&t).ok())
}

fn record(row: &Row) -> rusqlite::Result<SnapshotRecord> {
    let saved_at: Option<String> = row.get("saved_at")?;
    Ok(SnapshotRecord {
        id: row.get("id")?,
        scan_id: row.get("scan_id")?,
        root_path: row.get("root_path")?,
        findings: parse_json(row.get("findings_json")?).unwrap_or(Value::Array(vec![])),
        extensions: parse_json(row.get("extensions_json")?).unwrap_or(Value::Array(vec![])),
        scan_info: parse_json(row.get("scan_info_json")?).unwrap_or(Value::Null),
        // Python's isoformat(): the stored "YYYY-MM-DD HH:MM:SS.ffffff" with a T.
        saved_at: saved_at.unwrap_or_default().replacen(' ', "T", 1),
        total_files: row.get("total_files")?,
        total_folders: row.get("total_folders")?,
        total_size_bytes: row.get("total_size_bytes")?,
        snapshot_type: row.get::<_, Option<String>>("snapshot_type")?.unwrap_or_else(|| "scan".into()),
        target_path: row.get("target_path")?,
        comparison: parse_json(row.get("comparison_json")?),
        comparison_summary: parse_json(row.get("comparison_summary_json")?),
    })
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        // `di` writes to the same file from another process.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        let existing: Vec<String> = conn
            .prepare("PRAGMA table_info(snapshots)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<_, _>>()?;
        for (column, def) in LATER_COLUMNS {
            if !existing.iter().any(|c| c == column) {
                conn.execute_batch(&format!("ALTER TABLE snapshots ADD COLUMN {column} {def}"))?;
            }
        }
        Ok(Store { conn })
    }

    pub fn list(&self) -> rusqlite::Result<Vec<SnapshotRecord>> {
        let mut stmt = self.conn.prepare("SELECT * FROM snapshots ORDER BY saved_at DESC")?;
        let rows = stmt.query_map([], record)?.collect();
        rows
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<SnapshotRecord>> {
        self.conn.query_row("SELECT * FROM snapshots WHERE id = ?1", [id], record).optional()
    }

    pub fn insert(&self, id: &str, data: &SnapshotData) -> rusqlite::Result<SnapshotRecord> {
        self.conn.execute(
            "INSERT INTO snapshots (id, scan_id, root_path, findings_json, extensions_json, scan_info_json,
                saved_at, total_files, total_folders, total_size_bytes, snapshot_type, target_path,
                comparison_json, comparison_summary_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                id,
                data.scan_id,
                data.root_path,
                data.findings.to_string(),
                data.extensions.to_string(),
                data.scan_info.to_string(),
                utc_now(),
                data.total_files,
                data.total_folders,
                data.total_size_bytes,
                data.snapshot_type,
                data.target_path,
                data.comparison.as_ref().map(|v| v.to_string()),
                data.comparison_summary.as_ref().map(|v| v.to_string()),
            ],
        )?;
        Ok(self.get(id)?.expect("just inserted"))
    }

    /// Replace a snapshot's contents with fresh results, keeping its id.
    pub fn replace(&self, id: &str, data: &SnapshotData) -> rusqlite::Result<Option<SnapshotRecord>> {
        let changed = self.conn.execute(
            "UPDATE snapshots SET scan_id = ?2, findings_json = ?3, extensions_json = ?4, scan_info_json = ?5,
                saved_at = ?6, total_files = ?7, total_folders = ?8, total_size_bytes = ?9,
                comparison_json = ?10, comparison_summary_json = ?11
             WHERE id = ?1",
            params![
                id,
                data.scan_id,
                data.findings.to_string(),
                data.extensions.to_string(),
                data.scan_info.to_string(),
                utc_now(),
                data.total_files,
                data.total_folders,
                data.total_size_bytes,
                data.comparison.as_ref().map(|v| v.to_string()),
                data.comparison_summary.as_ref().map(|v| v.to_string()),
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get(id)
    }

    pub fn delete(&self, id: &str) -> rusqlite::Result<bool> {
        Ok(self.conn.execute("DELETE FROM snapshots WHERE id = ?1", [id])? > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample<'a>() -> SnapshotData<'a> {
        SnapshotData {
            scan_id: "scan-1",
            root_path: "/data",
            findings: json!([{"id": "finding-1", "category": "large_folder", "reason": "r", "paths": ["/data"], "total_bytes": 5}]),
            extensions: json!([]),
            scan_info: json!({"scan_id": "scan-1", "root_path": "/data", "total_files": 3}),
            total_files: 3,
            total_folders: 1,
            total_size_bytes: 5,
            snapshot_type: "scan",
            target_path: None,
            comparison: None,
            comparison_summary: None,
        }
    }

    #[test]
    fn round_trip_and_replace() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&tmp.path().join("db.sqlite")).unwrap();
        let saved = store.insert("snapshot-1", &sample()).unwrap();
        assert_eq!(saved.findings[0]["category"], "large_folder");
        assert!(saved.saved_at.contains('T'));
        let mut fresh = sample();
        fresh.total_files = 9;
        assert_eq!(store.replace("snapshot-1", &fresh).unwrap().unwrap().total_files, Some(9));
        assert_eq!(store.list().unwrap().len(), 1);
        assert!(store.delete("snapshot-1").unwrap());
        assert!(store.get("snapshot-1").unwrap().is_none());
    }

    #[test]
    fn upgrades_a_first_release_database() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("old.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE snapshots (id VARCHAR PRIMARY KEY, scan_id VARCHAR NOT NULL, root_path VARCHAR NOT NULL,
             findings_json TEXT NOT NULL, extensions_json TEXT NOT NULL, scan_info_json TEXT NOT NULL,
             saved_at DATETIME, total_files INTEGER, total_folders INTEGER, total_size_bytes INTEGER);
             INSERT INTO snapshots VALUES ('old', 's', '/x', '[]', '[]', '{}', '2025-01-02 03:04:05.000006', 1, 1, 1);",
        )
        .unwrap();
        drop(conn);
        let store = Store::open(&path).unwrap();
        let old = store.get("old").unwrap().unwrap();
        assert_eq!(old.snapshot_type, "scan");
        assert_eq!(old.saved_at, "2025-01-02T03:04:05.000006");
    }
}
