//! Snapshot storage in SQLite.
//!
//! Same file and schema as the Python backend's SQLAlchemy model, so
//! snapshots saved by the Electron app show up in the Tauri app.

use crate::model::Snapshot;
use crate::util::{db_time_to_iso, now_utc_db};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// `<data dir>/DiskIntelligence/disk_intelligence.db`: %APPDATA% on Windows,
/// ~/Library/Application Support on macOS, $XDG_DATA_HOME on Linux.
pub fn default_db_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("DiskIntelligence")
        .join("disk_intelligence.db")
}

pub struct SnapshotStore {
    conn: Connection,
}

/// A row to insert.
pub struct NewSnapshot<'a> {
    pub id: &'a str,
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

const COLUMNS: &str = "id, scan_id, root_path, findings_json, extensions_json, scan_info_json, \
    saved_at, total_files, total_folders, total_size_bytes, snapshot_type, target_path, \
    comparison_json, comparison_summary_json";

fn parse(text: Option<String>) -> Option<Value> {
    text.and_then(|t| serde_json::from_str(&t).ok())
}

fn from_row(row: &Row) -> rusqlite::Result<Snapshot> {
    Ok(Snapshot {
        id: row.get(0)?,
        scan_id: row.get(1)?,
        root_path: row.get(2)?,
        findings: parse(row.get(3)?).unwrap_or(Value::Array(vec![])),
        extensions: parse(row.get(4)?).unwrap_or(Value::Array(vec![])),
        scan_info: parse(row.get(5)?).unwrap_or(Value::Null),
        saved_at: row.get::<_, Option<String>>(6)?.map(|s| db_time_to_iso(&s)).unwrap_or_default(),
        total_files: row.get(7)?,
        total_folders: row.get(8)?,
        total_size_bytes: row.get(9)?,
        snapshot_type: row.get::<_, Option<String>>(10)?.unwrap_or_else(|| "scan".into()),
        target_path: row.get(11)?,
        comparison: parse(row.get(12)?),
        comparison_summary: parse(row.get(13)?),
    })
}

fn to_text(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

impl SnapshotStore {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        Self::init(Connection::open(path)?)
    }

    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS snapshots (
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
            CREATE INDEX IF NOT EXISTS ix_snapshots_root_path ON snapshots (root_path);",
        )?;
        // Databases from before comparison snapshots lack these columns.
        let existing: Vec<String> = conn
            .prepare("PRAGMA table_info(snapshots)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<_, _>>()?;
        for (name, def) in [
            ("snapshot_type", "VARCHAR DEFAULT 'scan'"),
            ("target_path", "VARCHAR"),
            ("comparison_json", "TEXT"),
            ("comparison_summary_json", "TEXT"),
        ] {
            if !existing.iter().any(|c| c == name) {
                conn.execute_batch(&format!("ALTER TABLE snapshots ADD COLUMN {name} {def}"))?;
            }
        }
        Ok(SnapshotStore { conn })
    }

    pub fn insert(&self, s: NewSnapshot) -> rusqlite::Result<Snapshot> {
        self.conn.execute(
            &format!("INSERT INTO snapshots ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"),
            params![
                s.id,
                s.scan_id,
                s.root_path,
                to_text(&s.findings),
                to_text(&s.extensions),
                to_text(&s.scan_info),
                now_utc_db(),
                s.total_files,
                s.total_folders,
                s.total_size_bytes,
                s.snapshot_type,
                s.target_path,
                s.comparison.as_ref().map(to_text),
                s.comparison_summary.as_ref().map(to_text),
            ],
        )?;
        self.get(s.id).map(|s| s.expect("just inserted"))
    }

    pub fn list(&self) -> rusqlite::Result<Vec<Snapshot>> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {COLUMNS} FROM snapshots ORDER BY saved_at DESC"))?;
        let rows = stmt.query_map([], from_row)?;
        rows.collect()
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<Snapshot>> {
        self.conn
            .query_row(&format!("SELECT {COLUMNS} FROM snapshots WHERE id = ?1"), [id], from_row)
            .optional()
    }

    /// Replace a scan snapshot's results after a re-scan.
    pub fn update_scan(
        &self,
        id: &str,
        scan_id: &str,
        findings: &Value,
        extensions: &Value,
        scan_info: &Value,
        totals: (i64, i64, i64),
    ) -> rusqlite::Result<Option<Snapshot>> {
        self.conn.execute(
            "UPDATE snapshots SET scan_id = ?2, findings_json = ?3, extensions_json = ?4,
                scan_info_json = ?5, total_files = ?6, total_folders = ?7,
                total_size_bytes = ?8, saved_at = ?9 WHERE id = ?1",
            params![
                id,
                scan_id,
                to_text(findings),
                to_text(extensions),
                to_text(scan_info),
                totals.0,
                totals.1,
                totals.2,
                now_utc_db()
            ],
        )?;
        self.get(id)
    }

    /// Replace a comparison snapshot's tree after re-running it.
    pub fn update_comparison(
        &self,
        id: &str,
        tree: &Value,
        summary: &Value,
        total_files: i64,
        total_size_bytes: i64,
    ) -> rusqlite::Result<Option<Snapshot>> {
        self.conn.execute(
            "UPDATE snapshots SET comparison_json = ?2, comparison_summary_json = ?3,
                total_files = ?4, total_size_bytes = ?5, saved_at = ?6 WHERE id = ?1",
            params![id, to_text(tree), to_text(summary), total_files, total_size_bytes, now_utc_db()],
        )?;
        self.get(id)
    }

    /// Returns false when there was no such snapshot.
    pub fn delete(&self, id: &str) -> rusqlite::Result<bool> {
        Ok(self.conn.execute("DELETE FROM snapshots WHERE id = ?1", [id])? > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample<'a>(id: &'a str) -> NewSnapshot<'a> {
        NewSnapshot {
            id,
            scan_id: "scan-1",
            root_path: "/r",
            findings: json!([{"id": "finding-1"}]),
            extensions: json!([]),
            scan_info: json!({"scan_id": "scan-1"}),
            total_files: 3,
            total_folders: 1,
            total_size_bytes: 99,
            snapshot_type: "scan",
            target_path: None,
            comparison: None,
            comparison_summary: None,
        }
    }

    #[test]
    fn round_trip() {
        let store = SnapshotStore::in_memory().unwrap();
        let saved = store.insert(sample("snapshot-a")).unwrap();
        assert_eq!(saved.findings[0]["id"], "finding-1");
        assert!(saved.saved_at.contains('T'));
        assert_eq!(store.list().unwrap().len(), 1);

        let json = serde_json::to_value(&saved).unwrap();
        assert!(json.get("comparison").is_none());
        assert_eq!(json["snapshot_type"], "scan");

        assert!(store.delete("snapshot-a").unwrap());
        assert!(!store.delete("snapshot-a").unwrap());
        assert!(store.get("snapshot-a").unwrap().is_none());
    }

    #[test]
    fn upgrades_an_old_python_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE snapshots (id VARCHAR PRIMARY KEY, scan_id VARCHAR NOT NULL,
                    root_path VARCHAR NOT NULL, findings_json TEXT NOT NULL,
                    extensions_json TEXT NOT NULL, scan_info_json TEXT NOT NULL,
                    saved_at DATETIME, total_files INTEGER, total_folders INTEGER,
                    total_size_bytes INTEGER);
                 INSERT INTO snapshots VALUES ('snapshot-old', 's', '/r', '[]', '[]', '{}',
                    '2026-03-09 10:00:00.000001', 1, 1, 1);",
            )
            .unwrap();
        }
        let store = SnapshotStore::open(&path).unwrap();
        let old = store.get("snapshot-old").unwrap().unwrap();
        assert_eq!(old.snapshot_type, "scan");
        assert_eq!(old.saved_at, "2026-03-09T10:00:00.000001");
    }
}
