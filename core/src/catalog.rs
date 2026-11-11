//! The offload catalog: which files were copied to which drive, with their
//! hashes, so they can be found, checked and brought back while the drive is
//! unplugged. It lives in the database snapshots use, in tables of its own.
//!
//! What a row claims is narrow on purpose. `state = 'verified'` means: at
//! `verified_at`, the file at that place on that store was read back and its
//! SHA-256 was `sha256`. Nothing is ever recorded as verified on the strength
//! of a copy call returning success.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS offload_stores (
    id TEXT NOT NULL PRIMARY KEY,
    label TEXT NOT NULL,
    last_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offload_jobs (
    id TEXT NOT NULL PRIMARY KEY,
    store_id TEXT NOT NULL,
    host TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    rel_base TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    last_checked_at TEXT,
    last_check_problems INTEGER,
    UNIQUE (store_id, host, source_path)
);
CREATE TABLE IF NOT EXISTS offload_files (
    job_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ns INTEGER,
    mode INTEGER,
    sha256 TEXT,
    link_target TEXT,
    src_stamp TEXT,
    state TEXT NOT NULL,
    error TEXT,
    verified_at TEXT,
    source_removed INTEGER NOT NULL DEFAULT 0,
    drive_state TEXT,
    PRIMARY KEY (job_id, rel_path)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS drive_catalogs (
    store_id TEXT NOT NULL PRIMARY KEY,
    gen TEXT NOT NULL,
    root_path TEXT NOT NULL,
    cataloged_at TEXT NOT NULL,
    files INTEGER NOT NULL,
    dirs INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    unreadable INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drive_entries (
    store_id TEXT NOT NULL,
    gen TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    parent TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    files INTEGER NOT NULL,
    mtime_ns INTEGER,
    unreadable INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (store_id, gen, rel_path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS drive_entries_parent ON drive_entries (store_id, gen, parent);
";

/// A folder on an external drive that holds offloaded files. It is known by
/// the id in its marker file, not by where it is mounted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoreRecord {
    pub id: String,
    pub label: String,
    pub last_path: String,
    pub created_at: String,
    pub last_seen_at: String,
}

/// One source folder (or file) offloaded to one store.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JobRecord {
    pub id: String,
    pub store_id: String,
    pub host: String,
    pub source_path: String,
    /// "dir" or "file"
    pub source_kind: String,
    /// Where it sits under the store's folder, "/"-separated.
    pub rel_base: String,
    /// "running", "complete" or "incomplete"
    pub state: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub last_check_problems: Option<i64>,
}

/// A job with its counts, for lists.
#[derive(Debug, Clone, Serialize)]
pub struct JobSummary {
    #[serde(flatten)]
    pub job: JobRecord,
    /// Files and links known to be on the drive.
    pub verified_files: i64,
    pub verified_bytes: i64,
    /// Of those, how many originals have been removed from this computer.
    pub removed_files: i64,
    pub removed_bytes: i64,
    /// Entries that could not be copied or were left out.
    pub problem_files: i64,
    /// Files the last check found missing or damaged on the drive.
    pub damaged_files: i64,
}

/// One file, folder or link in a job.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FileRow {
    pub job_id: String,
    pub rel_path: String,
    /// "file", "dir" or "symlink"
    pub kind: String,
    pub size: i64,
    pub mtime_ns: Option<i64>,
    pub mode: Option<i64>,
    pub sha256: Option<String>,
    pub link_target: Option<String>,
    pub src_stamp: Option<String>,
    /// "verified", "failed" or "skipped"
    pub state: String,
    pub error: Option<String>,
    pub verified_at: Option<String>,
    pub source_removed: bool,
    /// "ok", "missing" or "damaged", as of the last check.
    pub drive_state: Option<String>,
}

/// A search result: a file and where it lives.
#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub store_id: String,
    pub store_label: String,
    pub job_id: String,
    pub host: String,
    pub source_path: String,
    pub rel_base: String,
    pub rel_path: String,
    pub kind: String,
    pub size: i64,
    pub mtime_ns: Option<i64>,
    pub source_removed: bool,
    pub drive_state: Option<String>,
}

/// What a drive held when it was last cataloged: every file and folder
/// under its store folder, whether or not anything was offloaded to it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DriveCatalog {
    pub store_id: String,
    /// The folder that was read, as it was mounted then.
    pub root_path: String,
    pub cataloged_at: String,
    pub files: i64,
    pub dirs: i64,
    pub bytes: i64,
    /// Folders that could not be read (their contents are not listed).
    pub unreadable: i64,
}

/// One file, folder or link in a drive catalog. A folder's `size` and
/// `files` count everything under it.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct DriveEntry {
    /// "/"-separated, relative to the store folder; "" is the folder itself.
    pub rel_path: String,
    pub name: String,
    /// "file", "dir" or "symlink"
    pub kind: String,
    pub size: i64,
    pub files: i64,
    pub mtime_ns: Option<i64>,
    pub unreadable: bool,
}

/// A drive catalog search result.
#[derive(Debug, Clone, Serialize)]
pub struct DriveHit {
    pub store_id: String,
    pub store_label: String,
    #[serde(flatten)]
    pub entry: DriveEntry,
}

fn drive_catalog(row: &Row) -> rusqlite::Result<DriveCatalog> {
    Ok(DriveCatalog {
        store_id: row.get("store_id")?,
        root_path: row.get("root_path")?,
        cataloged_at: row.get("cataloged_at")?,
        files: row.get("files")?,
        dirs: row.get("dirs")?,
        bytes: row.get("bytes")?,
        unreadable: row.get("unreadable")?,
    })
}

fn drive_entry(row: &Row) -> rusqlite::Result<DriveEntry> {
    Ok(DriveEntry {
        rel_path: row.get("rel_path")?,
        name: row.get("name")?,
        kind: row.get("kind")?,
        size: row.get("size")?,
        files: row.get("files")?,
        mtime_ns: row.get("mtime_ns")?,
        unreadable: row.get::<_, i64>("unreadable")? != 0,
    })
}

/// The folder holding `rel`: "" for a top-level entry and for "" itself.
pub fn rel_parent(rel: &str) -> &str {
    rel.rfind('/').map(|i| &rel[..i]).unwrap_or("")
}

pub struct Catalog {
    conn: Connection,
    in_batch: bool,
    batched: u32,
    batch_started: std::time::Instant,
}

pub fn utc_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn job_record(row: &Row) -> rusqlite::Result<JobRecord> {
    Ok(JobRecord {
        id: row.get("id")?,
        store_id: row.get("store_id")?,
        host: row.get("host")?,
        source_path: row.get("source_path")?,
        source_kind: row.get("source_kind")?,
        rel_base: row.get("rel_base")?,
        state: row.get("state")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        last_checked_at: row.get("last_checked_at")?,
        last_check_problems: row.get("last_check_problems")?,
    })
}

fn file_row(row: &Row) -> rusqlite::Result<FileRow> {
    Ok(FileRow {
        job_id: row.get("job_id")?,
        rel_path: row.get("rel_path")?,
        kind: row.get("kind")?,
        size: row.get("size")?,
        mtime_ns: row.get("mtime_ns")?,
        mode: row.get("mode")?,
        sha256: row.get("sha256")?,
        link_target: row.get("link_target")?,
        src_stamp: row.get("src_stamp")?,
        state: row.get("state")?,
        error: row.get("error")?,
        verified_at: row.get("verified_at")?,
        source_removed: row.get::<_, i64>("source_removed")? != 0,
        drive_state: row.get("drive_state")?,
    })
}

fn store_record(row: &Row) -> rusqlite::Result<StoreRecord> {
    Ok(StoreRecord {
        id: row.get("id")?,
        label: row.get("label")?,
        last_path: row.get("last_path")?,
        created_at: row.get("created_at")?,
        last_seen_at: row.get("last_seen_at")?,
    })
}

/// Escape a search term for LIKE with `ESCAPE '\'`.
fn like_pattern(term: &str) -> String {
    let mut out = String::from("%");
    for c in term.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

type Sql<T> = rusqlite::Result<T>;

impl Catalog {
    pub fn open(path: &Path) -> Sql<Catalog> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        // A power cut must not leave the catalog claiming more than was
        // written: every commit goes to the disk before it returns.
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Catalog {
            conn,
            in_batch: false,
            batched: 0,
            batch_started: std::time::Instant::now(),
        })
    }

    // -- batching ----------------------------------------------------------

    /// Group the writes that follow into one transaction (see `commit`).
    fn begin(&mut self) -> Sql<()> {
        if !self.in_batch {
            self.conn.execute_batch("BEGIN IMMEDIATE")?;
            self.in_batch = true;
            self.batched = 0;
            self.batch_started = std::time::Instant::now();
        }
        Ok(())
    }

    /// Commit before slow work. An open batch holds the database's write
    /// lock, and `di` and the snapshot library write to the same file: they
    /// must not wait while a large file is copied or read back.
    pub fn settle(&mut self, upcoming_bytes: u64) -> Sql<()> {
        const SLOW: u64 = 4 * 1024 * 1024;
        if self.in_batch
            && (upcoming_bytes >= SLOW
                || self.batch_started.elapsed() >= std::time::Duration::from_millis(250))
        {
            self.commit()?;
        }
        Ok(())
    }

    /// Make everything written so far durable.
    pub fn commit(&mut self) -> Sql<()> {
        if self.in_batch {
            self.conn.execute_batch("COMMIT")?;
            self.in_batch = false;
            self.batched = 0;
        }
        Ok(())
    }

    /// Throw away writes that were not committed, as a crash would.
    pub fn rollback(&mut self) {
        if self.in_batch {
            let _ = self.conn.execute_batch("ROLLBACK");
            self.in_batch = false;
            self.batched = 0;
        }
    }

    fn batched_write(&mut self) -> Sql<()> {
        self.batched += 1;
        if self.batched >= 200 {
            self.commit()?;
        }
        Ok(())
    }

    // -- stores ------------------------------------------------------------

    pub fn upsert_store(&mut self, id: &str, label: &str, path: &str, created_at: &str) -> Sql<()> {
        self.conn.execute(
            "INSERT INTO offload_stores (id, label, last_path, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET label = excluded.label, last_path = excluded.last_path, last_seen_at = excluded.last_seen_at",
            params![id, label, path, created_at, utc_now()],
        )?;
        Ok(())
    }

    pub fn stores(&self) -> Sql<Vec<StoreRecord>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM offload_stores ORDER BY label COLLATE NOCASE, id")?;
        let rows = stmt.query_map([], store_record)?.collect();
        rows
    }

    pub fn store(&self, id: &str) -> Sql<Option<StoreRecord>> {
        self.conn
            .query_row(
                "SELECT * FROM offload_stores WHERE id = ?1",
                [id],
                store_record,
            )
            .optional()
    }

    /// Note that a store was found at `path` just now.
    pub fn store_seen(&mut self, id: &str, path: &str) -> Sql<()> {
        self.conn.execute(
            "UPDATE offload_stores SET last_path = ?2, last_seen_at = ?3 WHERE id = ?1",
            params![id, path, utc_now()],
        )?;
        Ok(())
    }

    // -- jobs --------------------------------------------------------------

    pub fn find_job(
        &self,
        store_id: &str,
        host: &str,
        source_path: &str,
    ) -> Sql<Option<JobRecord>> {
        self.conn
            .query_row(
                "SELECT * FROM offload_jobs WHERE store_id = ?1 AND host = ?2 AND source_path = ?3",
                params![store_id, host, source_path],
                job_record,
            )
            .optional()
    }

    /// The job for this source on this store, started fresh or reopened.
    pub fn open_job(
        &mut self,
        store_id: &str,
        host: &str,
        source_path: &str,
        source_kind: &str,
        rel_base: &str,
    ) -> Sql<JobRecord> {
        let id = match self.find_job(store_id, host, source_path)? {
            Some(job) => {
                self.conn.execute(
                    "UPDATE offload_jobs SET state = 'running', started_at = ?2, finished_at = NULL WHERE id = ?1",
                    params![job.id, utc_now()],
                )?;
                job.id
            }
            None => {
                let id = format!("job-{}", uuid::Uuid::new_v4());
                self.conn.execute(
                    "INSERT INTO offload_jobs (id, store_id, host, source_path, source_kind, rel_base, state, started_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7)",
                    params![id, store_id, host, source_path, source_kind, rel_base, utc_now()],
                )?;
                id
            }
        };
        Ok(self.job(&id)?.expect("just written"))
    }

    /// Add a job read from a drive's own manifest, unless it is already here.
    pub fn import_job(&mut self, job: &JobRecord) -> Sql<bool> {
        let changed = self.conn.execute(
            "INSERT OR IGNORE INTO offload_jobs (id, store_id, host, source_path, source_kind, rel_base, state, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![job.id, job.store_id, job.host, job.source_path, job.source_kind, job.rel_base, job.state, job.started_at, job.finished_at],
        )?;
        Ok(changed > 0)
    }

    pub fn finish_job(&mut self, id: &str, state: &str) -> Sql<()> {
        self.conn.execute(
            "UPDATE offload_jobs SET state = ?2, finished_at = ?3 WHERE id = ?1",
            params![id, state, utc_now()],
        )?;
        Ok(())
    }

    pub fn job_checked(&mut self, id: &str, problems: i64) -> Sql<()> {
        self.conn.execute(
            "UPDATE offload_jobs SET last_checked_at = ?2, last_check_problems = ?3 WHERE id = ?1",
            params![id, utc_now(), problems],
        )?;
        Ok(())
    }

    pub fn job(&self, id: &str) -> Sql<Option<JobRecord>> {
        self.conn
            .query_row("SELECT * FROM offload_jobs WHERE id = ?1", [id], job_record)
            .optional()
    }

    pub fn jobs(&self) -> Sql<Vec<JobSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT j.*,
                COALESCE(SUM(f.state = 'verified' AND f.kind != 'dir'), 0) AS verified_files,
                COALESCE(SUM(CASE WHEN f.state = 'verified' AND f.kind != 'dir' THEN f.size ELSE 0 END), 0) AS verified_bytes,
                COALESCE(SUM(f.state = 'verified' AND f.kind != 'dir' AND f.source_removed = 1), 0) AS removed_files,
                COALESCE(SUM(CASE WHEN f.state = 'verified' AND f.kind != 'dir' AND f.source_removed = 1 THEN f.size ELSE 0 END), 0) AS removed_bytes,
                COALESCE(SUM(f.state != 'verified'), 0) AS problem_files,
                COALESCE(SUM(f.state = 'verified' AND f.drive_state IN ('missing', 'damaged')), 0) AS damaged_files
             FROM offload_jobs j LEFT JOIN offload_files f ON f.job_id = j.id
             GROUP BY j.id ORDER BY j.started_at DESC, j.id",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(JobSummary {
                    job: job_record(row)?,
                    verified_files: row.get("verified_files")?,
                    verified_bytes: row.get("verified_bytes")?,
                    removed_files: row.get("removed_files")?,
                    removed_bytes: row.get("removed_bytes")?,
                    problem_files: row.get("problem_files")?,
                    damaged_files: row.get("damaged_files")?,
                })
            })?
            .collect();
        rows
    }

    /// Forget a job. This only removes the catalog's record of it; nothing on
    /// the drive or the computer is touched.
    pub fn forget_job(&mut self, id: &str) -> Sql<bool> {
        self.commit()?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM offload_files WHERE job_id = ?1", [id])?;
        let gone = tx.execute("DELETE FROM offload_jobs WHERE id = ?1", [id])? > 0;
        tx.commit()?;
        Ok(gone)
    }

    // -- files -------------------------------------------------------------

    /// Record that an entry is on the drive and was read back correctly.
    pub fn record_verified(&mut self, row: &FileRow) -> Sql<()> {
        self.begin()?;
        self.conn.execute(
            "INSERT INTO offload_files (job_id, rel_path, kind, size, mtime_ns, mode, sha256, link_target, src_stamp,
                state, error, verified_at, source_removed, drive_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'verified', NULL, ?10, ?11, 'ok')
             ON CONFLICT(job_id, rel_path) DO UPDATE SET kind = excluded.kind, size = excluded.size, mtime_ns = excluded.mtime_ns,
                mode = excluded.mode, sha256 = excluded.sha256, link_target = excluded.link_target, src_stamp = excluded.src_stamp,
                state = 'verified', error = NULL, verified_at = excluded.verified_at, source_removed = excluded.source_removed,
                drive_state = 'ok'",
            params![
                row.job_id,
                row.rel_path,
                row.kind,
                row.size,
                row.mtime_ns,
                row.mode,
                row.sha256,
                row.link_target,
                row.src_stamp,
                row.verified_at.clone().unwrap_or_else(utc_now),
                row.source_removed as i64,
            ],
        )?;
        self.batched_write()
    }

    /// Record that an entry was not copied. An entry already known to be on
    /// the drive stays that way: a later failure (say, the file now differs
    /// locally) does not undo what was verified before.
    pub fn record_problem(
        &mut self,
        job_id: &str,
        rel_path: &str,
        kind: &str,
        state: &str,
        error: &str,
    ) -> Sql<()> {
        self.begin()?;
        self.conn.execute(
            "INSERT INTO offload_files (job_id, rel_path, kind, state, error) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(job_id, rel_path) DO UPDATE SET kind = excluded.kind, state = excluded.state, error = excluded.error
             WHERE offload_files.state != 'verified'",
            params![job_id, rel_path, kind, state, error],
        )?;
        self.batched_write()
    }

    /// Forget what earlier runs could not copy. The run that follows finds
    /// each problem again if it is still one. Verified entries are untouched.
    pub fn clear_problems(&mut self, job_id: &str) -> Sql<()> {
        self.begin()?;
        self.conn.execute(
            "DELETE FROM offload_files WHERE job_id = ?1 AND state != 'verified'",
            [job_id],
        )?;
        self.batched_write()
    }

    /// How many files and links of a job are on the drive, and their bytes.
    pub fn verified_totals(&self, job_id: &str) -> Sql<(u64, u64)> {
        self.conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM offload_files
             WHERE job_id = ?1 AND state = 'verified' AND kind != 'dir'",
            [job_id],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
        )
    }

    pub fn set_source_removed(&mut self, job_id: &str, rel_path: &str, removed: bool) -> Sql<()> {
        self.begin()?;
        self.conn.execute(
            "UPDATE offload_files SET source_removed = ?3 WHERE job_id = ?1 AND rel_path = ?2",
            params![job_id, rel_path, removed as i64],
        )?;
        self.batched_write()
    }

    /// The whole source went at once (to the Trash): every copied entry's
    /// original is gone.
    pub fn mark_all_removed(&mut self, job_id: &str) -> Sql<()> {
        self.conn.execute(
            "UPDATE offload_files SET source_removed = 1 WHERE job_id = ?1 AND state = 'verified'",
            [job_id],
        )?;
        Ok(())
    }

    pub fn set_drive_state(&mut self, job_id: &str, rel_path: &str, drive_state: &str) -> Sql<()> {
        self.begin()?;
        self.conn.execute(
            "UPDATE offload_files SET drive_state = ?3 WHERE job_id = ?1 AND rel_path = ?2",
            params![job_id, rel_path, drive_state],
        )?;
        self.batched_write()
    }

    pub fn file(&self, job_id: &str, rel_path: &str) -> Sql<Option<FileRow>> {
        self.conn
            .query_row(
                "SELECT * FROM offload_files WHERE job_id = ?1 AND rel_path = ?2",
                params![job_id, rel_path],
                file_row,
            )
            .optional()
    }

    /// A page of a job's rows in path order, after `after` (exclusive).
    /// Paging keeps memory flat for jobs with millions of files.
    pub fn files_after(
        &self,
        job_id: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Sql<Vec<FileRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM offload_files WHERE job_id = ?1 AND (?2 IS NULL OR rel_path > ?2) ORDER BY rel_path LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![job_id, after, limit as i64], file_row)?
            .collect();
        rows
    }

    /// Every row of a job (tests and small jobs).
    pub fn files(&self, job_id: &str) -> Sql<Vec<FileRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM offload_files WHERE job_id = ?1 ORDER BY rel_path")?;
        let rows = stmt.query_map([job_id], file_row)?.collect();
        rows
    }

    /// A job's folders, deepest first.
    pub fn dirs_deepest_first(&self, job_id: &str) -> Sql<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT rel_path FROM offload_files WHERE job_id = ?1 AND kind = 'dir' AND state = 'verified'")?;
        let mut dirs: Vec<String> = stmt
            .query_map([job_id], |r| r.get(0))?
            .collect::<Sql<_>>()?;
        dirs.sort_by(|a, b| {
            let depth = |p: &str| {
                if p.is_empty() {
                    0
                } else {
                    p.matches('/').count() + 1
                }
            };
            depth(b).cmp(&depth(a)).then_with(|| b.cmp(a))
        });
        Ok(dirs)
    }

    /// Entries that were not copied, for a job.
    pub fn problems(&self, job_id: &str, limit: usize) -> Sql<Vec<FileRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM offload_files WHERE job_id = ?1 AND (state != 'verified' OR drive_state IN ('missing', 'damaged'))
             ORDER BY rel_path LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![job_id, limit as i64], file_row)?
            .collect();
        rows
    }

    // -- drive catalogs ----------------------------------------------------
    //
    // A new catalog of a drive is written beside the old one under a fresh
    // `gen`, and replaces it only once it is complete: a cancelled or crashed
    // run leaves the previous catalog as it was.

    /// Start a new catalog of a store: clear what an unfinished earlier run
    /// left, and return the generation to write under.
    pub fn begin_drive_catalog(&mut self, store_id: &str) -> Sql<String> {
        self.commit()?;
        self.conn.execute(
            "DELETE FROM drive_entries WHERE store_id = ?1
             AND gen IS NOT (SELECT gen FROM drive_catalogs WHERE store_id = ?1)",
            params![store_id],
        )?;
        Ok(uuid::Uuid::new_v4().simple().to_string())
    }

    pub fn add_drive_entry(&mut self, store_id: &str, gen: &str, entry: &DriveEntry) -> Sql<()> {
        self.begin()?;
        self.conn.execute(
            "INSERT OR REPLACE INTO drive_entries (store_id, gen, rel_path, parent, name, kind, size, files, mtime_ns, unreadable)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                store_id,
                gen,
                entry.rel_path,
                rel_parent(&entry.rel_path),
                entry.name,
                entry.kind,
                entry.size,
                entry.files,
                entry.mtime_ns,
                entry.unreadable as i64
            ],
        )?;
        self.batched_write()
    }

    /// Make the catalog written under `summary`'s generation the store's
    /// catalog, and drop the one it replaces.
    pub fn finish_drive_catalog(&mut self, gen: &str, summary: &DriveCatalog) -> Sql<()> {
        self.commit()?;
        self.begin()?;
        let result = (|| {
            self.conn.execute(
                "INSERT INTO drive_catalogs (store_id, gen, root_path, cataloged_at, files, dirs, bytes, unreadable)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(store_id) DO UPDATE SET gen = excluded.gen, root_path = excluded.root_path,
                    cataloged_at = excluded.cataloged_at, files = excluded.files, dirs = excluded.dirs,
                    bytes = excluded.bytes, unreadable = excluded.unreadable",
                params![
                    summary.store_id,
                    gen,
                    summary.root_path,
                    summary.cataloged_at,
                    summary.files,
                    summary.dirs,
                    summary.bytes,
                    summary.unreadable
                ],
            )?;
            self.conn.execute(
                "DELETE FROM drive_entries WHERE store_id = ?1 AND gen != ?2",
                params![summary.store_id, gen],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => self.commit(),
            Err(e) => {
                self.rollback();
                Err(e)
            }
        }
    }

    /// Throw away an unfinished catalog; the previous one stays.
    pub fn abandon_drive_catalog(&mut self, store_id: &str, gen: &str) -> Sql<()> {
        self.rollback();
        self.conn.execute(
            "DELETE FROM drive_entries WHERE store_id = ?1 AND gen = ?2",
            params![store_id, gen],
        )?;
        Ok(())
    }

    pub fn drive_catalogs(&self) -> Sql<Vec<DriveCatalog>> {
        let mut stmt = self.conn.prepare("SELECT * FROM drive_catalogs")?;
        let rows = stmt.query_map([], drive_catalog)?.collect();
        rows
    }

    pub fn drive_catalog(&self, store_id: &str) -> Sql<Option<DriveCatalog>> {
        self.conn
            .query_row(
                "SELECT * FROM drive_catalogs WHERE store_id = ?1",
                params![store_id],
                drive_catalog,
            )
            .optional()
    }

    /// One entry of a store's current catalog.
    pub fn drive_entry(&self, store_id: &str, rel_path: &str) -> Sql<Option<DriveEntry>> {
        self.conn
            .query_row(
                "SELECT e.* FROM drive_entries e JOIN drive_catalogs c ON c.store_id = e.store_id AND c.gen = e.gen
                 WHERE e.store_id = ?1 AND e.rel_path = ?2",
                params![store_id, rel_path],
                drive_entry,
            )
            .optional()
    }

    /// What a folder of a store's current catalog holds: folders first, then
    /// the biggest first.
    pub fn drive_children(
        &self,
        store_id: &str,
        parent: &str,
        limit: usize,
    ) -> Sql<Vec<DriveEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT e.* FROM drive_entries e JOIN drive_catalogs c ON c.store_id = e.store_id AND c.gen = e.gen
             WHERE e.store_id = ?1 AND e.parent = ?2 AND e.rel_path != ''
             ORDER BY e.kind = 'dir' DESC, e.size DESC, e.name COLLATE NOCASE LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![store_id, parent, limit as i64], drive_entry)?
            .collect();
        rows
    }

    /// Entries of any drive catalog whose path contains every word of `query`.
    pub fn drive_search(&self, query: &str, limit: usize) -> Sql<Vec<DriveHit>> {
        let words: Vec<String> = query.split_whitespace().map(like_pattern).collect();
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let mut sql = String::from(
            "SELECT e.*, s.label AS store_label FROM drive_entries e
             JOIN drive_catalogs c ON c.store_id = e.store_id AND c.gen = e.gen
             JOIN offload_stores s ON s.id = e.store_id
             WHERE e.rel_path != ''",
        );
        for i in 0..words.len() {
            sql.push_str(&format!(" AND e.rel_path LIKE ?{} ESCAPE '\\'", i + 1));
        }
        sql.push_str(&format!(
            " ORDER BY e.kind = 'dir' DESC, length(e.rel_path), e.rel_path LIMIT {}",
            limit.min(5000)
        ));
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(words.iter()), |row| {
                Ok(DriveHit {
                    store_id: row.get("store_id")?,
                    store_label: row.get("store_label")?,
                    entry: drive_entry(row)?,
                })
            })?
            .collect();
        rows
    }

    /// Forget a drive's catalog. Nothing on the drive is touched.
    pub fn forget_drive_catalog(&mut self, store_id: &str) -> Sql<bool> {
        self.commit()?;
        self.conn.execute(
            "DELETE FROM drive_entries WHERE store_id = ?1",
            params![store_id],
        )?;
        let n = self.conn.execute(
            "DELETE FROM drive_catalogs WHERE store_id = ?1",
            params![store_id],
        )?;
        Ok(n > 0)
    }

    /// Files whose path contains every word of `query`, on any store.
    pub fn search(&self, query: &str, limit: usize) -> Sql<Vec<Hit>> {
        let words: Vec<String> = query.split_whitespace().map(like_pattern).collect();
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let mut sql = String::from(
            "SELECT s.id AS store_id, s.label AS store_label, j.id AS job_id, j.host, j.source_path, j.rel_base,
                    f.rel_path, f.kind, f.size, f.mtime_ns, f.source_removed, f.drive_state
             FROM offload_files f JOIN offload_jobs j ON j.id = f.job_id JOIN offload_stores s ON s.id = j.store_id
             WHERE f.state = 'verified'",
        );
        for i in 0..words.len() {
            sql.push_str(&format!(
                " AND (j.source_path || '/' || f.rel_path) LIKE ?{} ESCAPE '\\'",
                i + 1
            ));
        }
        sql.push_str(&format!(
            " ORDER BY f.kind = 'dir' DESC, length(f.rel_path), f.rel_path LIMIT {}",
            limit.min(5000)
        ));
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(words.iter()), |row| {
                Ok(Hit {
                    store_id: row.get("store_id")?,
                    store_label: row.get("store_label")?,
                    job_id: row.get("job_id")?,
                    host: row.get("host")?,
                    source_path: row.get("source_path")?,
                    rel_base: row.get("rel_base")?,
                    rel_path: row.get("rel_path")?,
                    kind: row.get("kind")?,
                    size: row.get("size")?,
                    mtime_ns: row.get("mtime_ns")?,
                    source_removed: row.get::<_, i64>("source_removed")? != 0,
                    drive_state: row.get("drive_state")?,
                })
            })?
            .collect();
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verified(job: &str, rel: &str, size: i64) -> FileRow {
        FileRow {
            job_id: job.into(),
            rel_path: rel.into(),
            kind: "file".into(),
            size,
            sha256: Some("aa".into()),
            state: "verified".into(),
            ..FileRow::default()
        }
    }

    fn catalog() -> (tempfile::TempDir, Catalog) {
        let tmp = tempfile::tempdir().unwrap();
        let catalog = Catalog::open(&tmp.path().join("db.sqlite")).unwrap();
        (tmp, catalog)
    }

    #[test]
    fn a_later_failure_never_downgrades_a_verified_row() {
        let (_tmp, mut c) = catalog();
        c.upsert_store("s", "Drive", "/mnt/x", &utc_now()).unwrap();
        let job = c
            .open_job("s", "host", "/data", "dir", "host/data")
            .unwrap();
        c.record_verified(&verified(&job.id, "a.txt", 5)).unwrap();
        c.record_problem(&job.id, "a.txt", "file", "failed", "differs now")
            .unwrap();
        c.record_problem(&job.id, "b.txt", "file", "failed", "unreadable")
            .unwrap();
        c.commit().unwrap();
        assert_eq!(c.file(&job.id, "a.txt").unwrap().unwrap().state, "verified");
        assert_eq!(c.file(&job.id, "b.txt").unwrap().unwrap().state, "failed");
        // ...and a failed row becomes verified once the copy succeeds.
        c.record_verified(&verified(&job.id, "b.txt", 7)).unwrap();
        c.commit().unwrap();
        let summary = &c.jobs().unwrap()[0];
        assert_eq!(
            (
                summary.verified_files,
                summary.verified_bytes,
                summary.problem_files
            ),
            (2, 12, 0)
        );
    }

    #[test]
    fn reopening_a_job_keeps_its_id_and_rows() {
        let (_tmp, mut c) = catalog();
        c.upsert_store("s", "Drive", "/mnt/x", &utc_now()).unwrap();
        let first = c
            .open_job("s", "host", "/data", "dir", "host/data")
            .unwrap();
        c.record_verified(&verified(&first.id, "a.txt", 5)).unwrap();
        c.commit().unwrap();
        let again = c
            .open_job("s", "host", "/data", "dir", "host/data")
            .unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(c.files(&again.id).unwrap().len(), 1);
        // The same folder on another computer is a different job.
        assert_ne!(
            c.open_job("s", "other", "/data", "dir", "other/data")
                .unwrap()
                .id,
            first.id
        );
    }

    #[test]
    fn a_batch_is_closed_before_slow_work_so_others_can_write() {
        let (tmp, mut c) = catalog();
        c.upsert_store("s", "Drive", "/mnt/x", &utc_now()).unwrap();
        let job = c
            .open_job("s", "host", "/data", "dir", "host/data")
            .unwrap();
        let other = Connection::open(tmp.path().join("db.sqlite")).unwrap();
        other.busy_timeout(std::time::Duration::ZERO).unwrap();
        let write =
            |conn: &Connection| conn.execute("CREATE TABLE IF NOT EXISTS elsewhere (x)", []);

        c.record_verified(&verified(&job.id, "a.txt", 1)).unwrap();
        assert!(write(&other).is_err(), "an open batch holds the write lock");
        c.settle(100 * 1024 * 1024).unwrap();
        write(&other).expect("a big file is coming: the batch is committed first");
        assert_eq!(c.files(&job.id).unwrap().len(), 1);
    }

    #[test]
    fn uncommitted_rows_vanish_on_rollback() {
        let (_tmp, mut c) = catalog();
        c.upsert_store("s", "Drive", "/mnt/x", &utc_now()).unwrap();
        let job = c
            .open_job("s", "host", "/data", "dir", "host/data")
            .unwrap();
        c.record_verified(&verified(&job.id, "kept.txt", 1))
            .unwrap();
        c.commit().unwrap();
        c.record_verified(&verified(&job.id, "lost.txt", 1))
            .unwrap();
        c.rollback();
        let names: Vec<String> = c
            .files(&job.id)
            .unwrap()
            .into_iter()
            .map(|f| f.rel_path)
            .collect();
        assert_eq!(names, ["kept.txt"]);
    }

    #[test]
    fn search_matches_every_word_and_treats_wildcards_literally() {
        let (_tmp, mut c) = catalog();
        c.upsert_store("s", "Blue drive", "/mnt/x", &utc_now())
            .unwrap();
        let job = c
            .open_job("s", "host", "/home/me/Movies", "dir", "host/home/me/Movies")
            .unwrap();
        for rel in [
            "2023/trip_final.mov",
            "2023/trip%final.mov",
            "2024/other.mov",
        ] {
            c.record_verified(&verified(&job.id, rel, 1)).unwrap();
        }
        c.record_problem(&job.id, "2023/trip_broken.mov", "file", "failed", "x")
            .unwrap();
        c.commit().unwrap();
        let found = |q: &str| {
            c.search(q, 50)
                .unwrap()
                .into_iter()
                .map(|h| h.rel_path)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            found("2023 TRIP").len(),
            2,
            "both words, any case, and never a failed copy"
        );
        assert_eq!(
            found("trip_final"),
            ["2023/trip_final.mov"],
            "_ is not a wildcard"
        );
        assert_eq!(
            found("trip%final"),
            ["2023/trip%final.mov"],
            "% is not a wildcard"
        );
        assert_eq!(
            found("movies other"),
            ["2024/other.mov"],
            "the original folder's path counts"
        );
        assert!(found("   ").is_empty());
    }

    #[test]
    fn folders_come_back_deepest_first() {
        let (_tmp, mut c) = catalog();
        c.upsert_store("s", "Drive", "/mnt/x", &utc_now()).unwrap();
        let job = c
            .open_job("s", "host", "/data", "dir", "host/data")
            .unwrap();
        for rel in ["", "a", "a/b", "a/b/c", "z"] {
            let mut row = verified(&job.id, rel, 0);
            row.kind = "dir".into();
            c.record_verified(&row).unwrap();
        }
        c.commit().unwrap();
        assert_eq!(
            c.dirs_deepest_first(&job.id).unwrap(),
            ["a/b/c", "a/b", "z", "a", ""]
        );
    }
}
