-- Create snapshots table for disk scan results
CREATE TABLE snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    scan_id TEXT NOT NULL,
    root_path TEXT NOT NULL,
    findings_json TEXT NOT NULL,
    extensions_json TEXT NOT NULL,
    scan_info_json TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    total_files INTEGER,
    total_folders INTEGER,
    total_size_bytes INTEGER,
    snapshot_type TEXT DEFAULT 'scan',
    target_path TEXT,
    comparison_json TEXT,
    comparison_summary_json TEXT
);

-- Create indexes for common queries
CREATE INDEX idx_snapshots_root_path ON snapshots(root_path);
CREATE INDEX idx_snapshots_saved_at ON snapshots(saved_at);
CREATE INDEX idx_snapshots_snapshot_type ON snapshots(snapshot_type);