"""
Baseline storage for growth tracking.

Baselines live in the same SQLite file the GUI uses, in their own table, so a
scan taken from the terminal is visible to the app and vice versa. Plain
sqlite3 is used rather than the SQLAlchemy models so the CLI has no third-party
imports on its hot path.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS cli_baselines (
    id           TEXT PRIMARY KEY,
    root_path    TEXT NOT NULL,
    label        TEXT,
    taken_at     TEXT NOT NULL,
    taken_ts     REAL NOT NULL,
    depth        INTEGER NOT NULL,
    total_bytes  INTEGER NOT NULL,
    total_files  INTEGER NOT NULL,
    entries_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cli_baselines_root
    ON cli_baselines (root_path, taken_ts DESC);
"""


def default_db_path() -> str:
    """
    Resolve the database path, preferring the location the packaged app uses
    so the CLI and the GUI share one history.

    Override with DISK_INTELLIGENCE_DB.
    """
    override = os.environ.get("DISK_INTELLIGENCE_DB")
    if override:
        return os.path.abspath(os.path.expanduser(override))

    if sys.platform == "win32":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.environ.get(
            "XDG_DATA_HOME", os.path.join(os.path.expanduser("~"), ".local", "share")
        )

    app_dir = os.path.join(base, "DiskIntelligence")
    os.makedirs(app_dir, exist_ok=True)
    return os.path.join(app_dir, "disk_intelligence.db")


def connect(db_path: str | None = None) -> sqlite3.Connection:
    path = db_path or default_db_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def save_baseline(
    conn: sqlite3.Connection,
    root_path: str,
    depth: int,
    total_bytes: int,
    total_files: int,
    entries: dict[str, dict],
    label: str | None = None,
) -> str:
    """
    Persist one baseline. `entries` maps a path relative to the root onto
    {"size", "files", "newest_mtime"}.
    """
    baseline_id = uuid.uuid4().hex[:12]
    now = time.time()
    conn.execute(
        "INSERT INTO cli_baselines "
        "(id, root_path, label, taken_at, taken_ts, depth, total_bytes, total_files, entries_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            baseline_id,
            root_path,
            label,
            datetime.fromtimestamp(now, timezone.utc).isoformat(),
            now,
            depth,
            total_bytes,
            total_files,
            json.dumps(entries, separators=(",", ":")),
        ),
    )
    conn.commit()
    return baseline_id


def list_baselines(
    conn: sqlite3.Connection, root_path: str | None = None, limit: int = 50
) -> list[sqlite3.Row]:
    if root_path:
        cur = conn.execute(
            "SELECT id, root_path, label, taken_at, taken_ts, depth, total_bytes, total_files "
            "FROM cli_baselines WHERE root_path = ? ORDER BY taken_ts DESC LIMIT ?",
            (root_path, limit),
        )
    else:
        cur = conn.execute(
            "SELECT id, root_path, label, taken_at, taken_ts, depth, total_bytes, total_files "
            "FROM cli_baselines ORDER BY taken_ts DESC LIMIT ?",
            (limit,),
        )
    return cur.fetchall()


def get_baseline(conn: sqlite3.Connection, baseline_id: str) -> sqlite3.Row | None:
    cur = conn.execute("SELECT * FROM cli_baselines WHERE id = ?", (baseline_id,))
    return cur.fetchone()


def latest_baseline(
    conn: sqlite3.Connection, root_path: str, before_ts: float | None = None
) -> sqlite3.Row | None:
    """Most recent baseline for a root, optionally the newest one older than `before_ts`."""
    if before_ts is None:
        cur = conn.execute(
            "SELECT * FROM cli_baselines WHERE root_path = ? ORDER BY taken_ts DESC LIMIT 1",
            (root_path,),
        )
    else:
        cur = conn.execute(
            "SELECT * FROM cli_baselines WHERE root_path = ? AND taken_ts <= ? "
            "ORDER BY taken_ts DESC LIMIT 1",
            (root_path, before_ts),
        )
    return cur.fetchone()


def delete_baseline(conn: sqlite3.Connection, baseline_id: str) -> bool:
    cur = conn.execute("DELETE FROM cli_baselines WHERE id = ?", (baseline_id,))
    conn.commit()
    return cur.rowcount > 0


def prune_baselines(conn: sqlite3.Connection, root_path: str, keep: int) -> int:
    """Keep only the newest `keep` baselines for a root. Returns rows removed."""
    cur = conn.execute(
        "DELETE FROM cli_baselines WHERE id IN ("
        "  SELECT id FROM cli_baselines WHERE root_path = ? "
        "  ORDER BY taken_ts DESC LIMIT -1 OFFSET ?"
        ")",
        (root_path, keep),
    )
    conn.commit()
    return cur.rowcount


def entries_from_scan(result, root: str) -> dict[str, dict]:
    """Flatten a ScanResult into the compact form stored in a baseline."""
    entries: dict[str, dict] = {}
    for path, node in result.nodes.items():
        rel = os.path.relpath(path, root)
        entries[rel] = {
            "size": node.size,
            "files": node.files,
            "own": node.own_size,
            "newest_mtime": round(node.newest_mtime, 1),
        }
    return entries
