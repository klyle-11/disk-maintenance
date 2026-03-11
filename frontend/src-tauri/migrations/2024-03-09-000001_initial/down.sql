-- Drop indexes
DROP INDEX IF EXISTS idx_snapshots_root_path;
DROP INDEX IF EXISTS idx_snapshots_saved_at;
DROP INDEX IF EXISTS idx_snapshots_snapshot_type;

-- Drop snapshots table
DROP TABLE IF EXISTS snapshots;