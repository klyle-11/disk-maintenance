//! Cataloging a drive: a list of everything on an external drive, kept in the
//! offload catalog so it can be browsed and searched while the drive is
//! unplugged, and scanned (a folder or the whole drive) when it is plugged in.
//!
//! A catalog needs nothing to have been offloaded to the drive. It only
//! reads: the one thing it writes to the drive is the small marker file that
//! lets the app recognise the drive again wherever it is mounted, the same
//! marker an offload would write.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::Serialize;

use crate::catalog::{utc_now, Catalog, DriveCatalog, DriveEntry};
use crate::drives::{self, MANIFESTS, MARKER};
use crate::offload::{Control, TMP_PREFIX};

pub const PHASE_CATALOGING: u8 = 6;

/// Names in a drive's top folder that are the system's bookkeeping, not the
/// person's files.
const SYSTEM_TOP: &[&str] = &[
    "$RECYCLE.BIN",
    "System Volume Information",
    ".Spotlight-V100",
    ".Trashes",
    ".fseventsd",
    ".TemporaryItems",
    ".DocumentRevisions-V100",
    "lost+found",
];

#[derive(Debug, Clone, Serialize)]
pub struct CatalogReport {
    pub store_id: String,
    pub store_label: String,
    pub root: String,
    /// "complete" or "cancelled". A cancelled run leaves the previous
    /// catalog of the drive, if there was one, as it was.
    pub outcome: &'static str,
    pub files: i64,
    pub dirs: i64,
    pub bytes: i64,
    pub unreadable: i64,
}

fn mtime_ns(meta: &fs::Metadata) -> Option<i64> {
    let modified = meta.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_nanos()).ok()
}

/// Entries the catalog leaves out: the app's own files on the drive, files
/// still being written by an offload, and system folders at the top.
fn left_out(name: &str, top: bool) -> bool {
    name.starts_with(TMP_PREFIX)
        || name.starts_with(".di-tmp-")
        || name.starts_with(".di-probe-")
        || (top && (name == MARKER || name == MANIFESTS || SYSTEM_TOP.contains(&name)))
}

/// A folder being read: what is left to look at in it, and the totals of
/// what has been seen so far.
struct Frame {
    rel: String,
    path: PathBuf,
    names: Vec<OsString>,
    next: usize,
    size: i64,
    files: i64,
    mtime_ns: Option<i64>,
    unreadable: bool,
}

impl Frame {
    fn open(rel: String, path: PathBuf, mtime_ns: Option<i64>) -> Frame {
        let (names, unreadable) = match fs::read_dir(&path) {
            Ok(entries) => {
                let mut names = Vec::new();
                let mut broken = false;
                for entry in entries {
                    match entry {
                        Ok(entry) => names.push(entry.file_name()),
                        Err(_) => broken = true,
                    }
                }
                names.sort();
                (names, broken)
            }
            Err(_) => (Vec::new(), true),
        };
        Frame {
            rel,
            path,
            names,
            next: 0,
            size: 0,
            files: 0,
            mtime_ns,
            unreadable,
        }
    }
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

/// Read every file and folder under `root` into the catalog as the drive's
/// new catalog. `root` becomes an offload store (it gets a marker) if it is
/// not one yet, so a later offload to it lands on the same drive record.
pub fn catalog_drive(
    catalog: &mut Catalog,
    root: &Path,
    ctl: &Control,
) -> Result<CatalogReport, String> {
    let root = dunce::canonicalize(root)
        .map_err(|e| format!("The drive can't be opened: {} ({e})", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder.", root.display()));
    }
    let marker = drives::ensure_marker(&root).map_err(|e| {
        format!("{e}. The app leaves a small {MARKER} file on a drive it catalogs, so it knows the drive again later.")
    })?;
    let root_text = root.to_string_lossy().into_owned();
    let sql = |e: rusqlite::Error| format!("The catalog couldn't be written: {e}");
    catalog
        .upsert_store(&marker.id, &marker.label, &root_text, &marker.created_at)
        .map_err(sql)?;
    ctl.progress
        .phase
        .store(PHASE_CATALOGING, Ordering::Relaxed);
    let gen = catalog.begin_drive_catalog(&marker.id).map_err(sql)?;

    let mut report = CatalogReport {
        store_id: marker.id.clone(),
        store_label: marker.label.clone(),
        root: root_text.clone(),
        outcome: "complete",
        files: 0,
        dirs: 0,
        bytes: 0,
        unreadable: 0,
    };
    let walked = walk(catalog, &marker.id, &gen, &root, ctl, &mut report);
    match walked {
        Ok(true) => {
            let summary = DriveCatalog {
                store_id: marker.id.clone(),
                root_path: root_text,
                cataloged_at: utc_now(),
                files: report.files,
                dirs: report.dirs,
                bytes: report.bytes,
                unreadable: report.unreadable,
            };
            if let Err(e) = catalog.finish_drive_catalog(&gen, &summary) {
                let _ = catalog.abandon_drive_catalog(&marker.id, &gen);
                return Err(sql(e));
            }
            Ok(report)
        }
        Ok(false) => {
            catalog
                .abandon_drive_catalog(&marker.id, &gen)
                .map_err(sql)?;
            report.outcome = "cancelled";
            Ok(report)
        }
        Err(e) => {
            let _ = catalog.abandon_drive_catalog(&marker.id, &gen);
            Err(sql(e))
        }
    }
}

/// Walk the tree depth first without recursion, writing each folder once
/// everything in it has been counted. Ok(false) when cancelled.
fn walk(
    catalog: &mut Catalog,
    store_id: &str,
    gen: &str,
    root: &Path,
    ctl: &Control,
    report: &mut CatalogReport,
) -> rusqlite::Result<bool> {
    let root_mtime = fs::metadata(root).ok().as_ref().and_then(mtime_ns);
    let mut stack = vec![Frame::open(String::new(), root.to_path_buf(), root_mtime)];
    while let Some(frame) = stack.last_mut() {
        if ctl.cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        if frame.next >= frame.names.len() {
            let done = stack.pop().expect("a frame");
            if done.unreadable {
                report.unreadable += 1;
            }
            let name = Path::new(&done.rel)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            catalog.add_drive_entry(
                store_id,
                gen,
                &DriveEntry {
                    rel_path: done.rel.clone(),
                    name,
                    kind: "dir".into(),
                    size: done.size,
                    files: done.files,
                    mtime_ns: done.mtime_ns,
                    unreadable: done.unreadable,
                },
            )?;
            if let Some(parent) = stack.last_mut() {
                parent.size += done.size;
                parent.files += done.files;
                report.dirs += 1;
            }
            catalog.settle(0)?;
            continue;
        }
        let os_name = frame.names[frame.next].clone();
        frame.next += 1;
        let name = os_name.to_string_lossy().into_owned();
        if left_out(&name, frame.rel.is_empty()) {
            continue;
        }
        let path = frame.path.join(&os_name);
        let rel = join(&frame.rel, &name);
        let Ok(meta) = fs::symlink_metadata(&path) else {
            frame.unreadable = true;
            continue;
        };
        if meta.is_dir() {
            let child = Frame::open(rel, path, mtime_ns(&meta));
            if let Ok(mut current) = ctl.progress.current.try_lock() {
                current.clear();
                current.push_str(&child.rel);
            }
            stack.push(child);
            continue;
        }
        let kind = if meta.file_type().is_symlink() {
            "symlink"
        } else {
            "file"
        };
        let size = if kind == "file" { meta.len() as i64 } else { 0 };
        frame.size += size;
        frame.files += 1;
        report.files += 1;
        report.bytes += size;
        ctl.progress.files_done.fetch_add(1, Ordering::Relaxed);
        ctl.progress
            .bytes_done
            .fetch_add(size as u64, Ordering::Relaxed);
        catalog.add_drive_entry(
            store_id,
            gen,
            &DriveEntry {
                rel_path: rel,
                name,
                kind: kind.into(),
                size,
                files: 1,
                mtime_ns: mtime_ns(&meta),
                unreadable: false,
            },
        )?;
    }
    Ok(true)
}
