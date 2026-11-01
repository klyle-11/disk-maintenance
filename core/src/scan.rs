//! The scanner: walks a folder tree in parallel and keeps per-folder totals.
//!
//! Memory stays proportional to the number of folders, not files: each folder
//! keeps its subtree's size, file count and newest times, and individual files
//! are only remembered when they are large enough to matter for duplicate
//! detection. Sizes are on-disk bytes from lstat (symlinks are not followed),
//! and a hard-linked file is counted once per scan.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use rayon::prelude::*;
use serde::Serialize;

use crate::util::should_ignore;

/// Files at least this big are kept for duplicate detection.
pub const LARGE_FILE_THRESHOLD: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Folder {
    pub path: String,
    /// Bytes in this folder and everything under it.
    pub total_size: u64,
    pub file_count: u64,
    /// Newest file modification / access time beneath it (0.0 if no files).
    pub last_modified: f64,
    pub last_accessed: f64,
}

#[derive(Debug, Default)]
pub struct ScanData {
    pub folders: Vec<Folder>,
    /// Lower-cased extension (with the dot, "" for none) → (files, bytes).
    pub extensions: HashMap<String, (u64, u64)>,
    /// (path, apparent size) of every file >= LARGE_FILE_THRESHOLD.
    pub large_files: Vec<(String, u64)>,
    pub total_files: u64,
    pub total_size: u64,
}

/// Live counters a caller can read while a scan runs.
#[derive(Default)]
pub struct Progress {
    pub files: AtomicU64,
    pub bytes: AtomicU64,
    pub folders: AtomicU64,
    /// Top-level folders finished, out of `top_total`: the only honest measure
    /// of how far along a walk is without walking twice.
    pub top_done: AtomicU64,
    pub top_total: AtomicU64,
    pub current: Mutex<String>,
}

impl Progress {
    pub fn percent(&self) -> u32 {
        let total = self.top_total.load(Ordering::Relaxed);
        if total == 0 {
            return 5;
        }
        let done = self.top_done.load(Ordering::Relaxed).min(total);
        (5 + done * 90 / total) as u32
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub files_scanned: u64,
    pub folders_scanned: u64,
    pub bytes_scanned: u64,
    pub current_path: String,
    pub progress_percent: u32,
    pub elapsed_seconds: f64,
    pub message: String,
}

#[derive(Default, Clone, Copy)]
struct Totals {
    size: u64,
    files: u64,
    modified: f64,
    accessed: f64,
}

impl Totals {
    fn add(&mut self, other: Totals) {
        self.size += other.size;
        self.files += other.files;
        self.modified = self.modified.max(other.modified);
        self.accessed = self.accessed.max(other.accessed);
    }
}

struct Walker<'a> {
    progress: &'a Progress,
    cancel: &'a AtomicBool,
    folders: Mutex<Vec<Folder>>,
    extensions: Mutex<HashMap<String, (u64, u64)>>,
    large_files: Mutex<Vec<(String, u64)>>,
    shared: Mutex<Vec<SharedFile>>,
}

/// A file with other hard links. Its bytes are counted once, settled after the
/// walk so the same copy always gets them, whatever order threads reach them.
struct SharedFile {
    key: (u64, u64),
    path: PathBuf,
    disk_size: u64,
    apparent: u64,
    modified: f64,
    accessed: f64,
    extension: String,
}

struct FileInfo {
    disk_size: u64,
    apparent: u64,
    modified: f64,
    accessed: f64,
    /// (device, inode) when the file has other hard links.
    shared: Option<(u64, u64)>,
}

#[cfg(unix)]
fn file_info(meta: &fs::Metadata) -> FileInfo {
    use std::os::unix::fs::MetadataExt;
    FileInfo {
        disk_size: meta.blocks() * 512,
        apparent: meta.len(),
        modified: meta.mtime() as f64 + meta.mtime_nsec() as f64 / 1e9,
        accessed: meta.atime() as f64 + meta.atime_nsec() as f64 / 1e9,
        shared: (meta.nlink() > 1).then(|| (meta.dev(), meta.ino())),
    }
}

/// Windows has no block counts or (stable) inode numbers: apparent sizes, and
/// no hard-link dedupe.
#[cfg(not(unix))]
fn file_info(meta: &fs::Metadata) -> FileInfo {
    use crate::util::epoch_secs;
    FileInfo {
        disk_size: meta.len(),
        apparent: meta.len(),
        modified: epoch_secs(meta.modified()),
        accessed: epoch_secs(meta.accessed()),
        shared: None,
    }
}

fn extension_of(name: &str) -> String {
    // Like Python's os.path.splitext: ".bashrc" has no extension.
    let trimmed = name.trim_start_matches('.');
    match trimmed.rfind('.') {
        Some(i) => trimmed[i..].to_lowercase(),
        None => String::new(),
    }
}

impl Walker<'_> {
    /// Walk one folder; returns its subtree totals, or None when it couldn't be
    /// read (it then isn't recorded at all, as an unreadable folder isn't).
    fn walk(&self, dir: &Path, top_level: bool) -> Option<Totals> {
        if self.cancel.load(Ordering::Relaxed) {
            return None;
        }
        let entries = fs::read_dir(dir).ok()?;
        if let Ok(mut current) = self.progress.current.try_lock() {
            *current = dir.to_string_lossy().into_owned();
        }

        let mut own = Totals::default();
        let mut subdirs: Vec<PathBuf> = Vec::new();
        let mut extensions: HashMap<String, (u64, u64)> = HashMap::new();
        let mut large: Vec<(String, u64)> = Vec::new();
        let mut shared: Vec<SharedFile> = Vec::new();

        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                if !should_ignore(&path) {
                    subdirs.push(path);
                }
                continue;
            }
            // A symlink to a folder is neither walked nor counted.
            if kind.is_symlink() && fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false) {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            let info = file_info(&meta);
            own.files += 1;
            self.progress.files.fetch_add(1, Ordering::Relaxed);

            let name = entry.file_name().to_string_lossy().into_owned();
            // A hard-linked file still counts as a file here; its bytes are
            // settled once the walk is done (see settle_hard_links).
            if let Some(key) = info.shared {
                shared.push(SharedFile {
                    key,
                    path,
                    disk_size: info.disk_size,
                    apparent: info.apparent,
                    modified: info.modified,
                    accessed: info.accessed,
                    extension: extension_of(&name),
                });
                continue;
            }
            own.size += info.disk_size;
            own.modified = own.modified.max(info.modified);
            own.accessed = own.accessed.max(info.accessed);
            self.progress.bytes.fetch_add(info.disk_size, Ordering::Relaxed);

            let ext = extensions.entry(extension_of(&name)).or_default();
            ext.0 += 1;
            ext.1 += info.disk_size;
            if info.apparent >= LARGE_FILE_THRESHOLD {
                large.push((path.to_string_lossy().into_owned(), info.apparent));
            }
        }

        if !extensions.is_empty() {
            let mut all = self.extensions.lock().unwrap();
            for (ext, (count, bytes)) in extensions {
                let slot = all.entry(ext).or_default();
                slot.0 += count;
                slot.1 += bytes;
            }
        }
        if !large.is_empty() {
            self.large_files.lock().unwrap().extend(large);
        }
        if !shared.is_empty() {
            self.shared.lock().unwrap().extend(shared);
        }

        if top_level {
            self.progress.top_total.store(subdirs.len() as u64, Ordering::Relaxed);
        }
        let children = subdirs
            .par_iter()
            .map(|sub| {
                let totals = self.walk(sub, false);
                if top_level {
                    self.progress.top_done.fetch_add(1, Ordering::Relaxed);
                }
                totals.unwrap_or_default()
            })
            .reduce(Totals::default, |mut a, b| {
                a.add(b);
                a
            });

        let mut totals = own;
        totals.add(children);
        self.progress.folders.fetch_add(1, Ordering::Relaxed);
        self.folders.lock().unwrap().push(Folder {
            path: dir.to_string_lossy().into_owned(),
            total_size: totals.size,
            file_count: totals.files,
            last_modified: totals.modified,
            last_accessed: totals.accessed,
        });
        Some(totals)
    }
}

/// Scan `root`. Returns None if it was cancelled.
pub fn scan(root: &Path, progress: &Progress, cancel: &AtomicBool) -> Option<ScanData> {
    let walker = Walker {
        progress,
        cancel,
        folders: Mutex::new(Vec::new()),
        extensions: Mutex::new(HashMap::new()),
        large_files: Mutex::new(Vec::new()),
        shared: Mutex::new(Vec::new()),
    };
    let totals = walker.walk(root, true).unwrap_or_default();
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let mut folders = walker.folders.into_inner().unwrap();
    if folders.is_empty() {
        // An unreadable root still counts as one (empty) folder.
        folders.push(Folder {
            path: root.to_string_lossy().into_owned(),
            total_size: 0,
            file_count: 0,
            last_modified: 0.0,
            last_accessed: 0.0,
        });
    }
    let mut extensions = walker.extensions.into_inner().unwrap();
    let mut large_files = walker.large_files.into_inner().unwrap();
    let mut total_size = totals.size;
    settle_hard_links(
        root,
        walker.shared.into_inner().unwrap(),
        &mut folders,
        &mut extensions,
        &mut large_files,
        &mut total_size,
        progress,
    );
    folders.sort_by(|a, b| a.path.cmp(&b.path));
    large_files.sort();
    Some(ScanData { folders, extensions, large_files, total_files: totals.files, total_size })
}

/// Count each hard-linked file's bytes once, against its alphabetically first
/// path: that copy's folder and every folder above it.
fn settle_hard_links(
    root: &Path,
    mut shared: Vec<SharedFile>,
    folders: &mut [Folder],
    extensions: &mut HashMap<String, (u64, u64)>,
    large_files: &mut Vec<(String, u64)>,
    total_size: &mut u64,
    progress: &Progress,
) {
    if shared.is_empty() {
        return;
    }
    shared.sort_by(|a, b| a.key.cmp(&b.key).then_with(|| a.path.cmp(&b.path)));
    shared.dedup_by(|later, first| later.key == first.key);
    let index: HashMap<String, usize> = folders.iter().enumerate().map(|(i, f)| (f.path.clone(), i)).collect();
    for file in shared {
        for dir in file.path.ancestors().skip(1) {
            if let Some(&i) = index.get(dir.to_string_lossy().as_ref()) {
                let folder = &mut folders[i];
                folder.total_size += file.disk_size;
                folder.last_modified = folder.last_modified.max(file.modified);
                folder.last_accessed = folder.last_accessed.max(file.accessed);
            }
            if dir == root {
                break;
            }
        }
        *total_size += file.disk_size;
        progress.bytes.fetch_add(file.disk_size, Ordering::Relaxed);
        let slot = extensions.entry(file.extension).or_default();
        slot.0 += 1;
        slot.1 += file.disk_size;
        if file.apparent >= LARGE_FILE_THRESHOLD {
            large_files.push((file.path.to_string_lossy().into_owned(), file.apparent));
        }
    }
}

/// A snapshot of the counters, as the progress event the UI shows.
pub fn progress_event(progress: &Progress, elapsed: f64) -> ProgressEvent {
    let current = progress.current.lock().map(|c| c.clone()).unwrap_or_default();
    ProgressEvent {
        files_scanned: progress.files.load(Ordering::Relaxed),
        folders_scanned: progress.folders.load(Ordering::Relaxed),
        bytes_scanned: progress.bytes.load(Ordering::Relaxed),
        progress_percent: progress.percent(),
        elapsed_seconds: elapsed,
        message: format!("Scanning: {current}"),
        current_path: current,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(path).unwrap().write_all(&vec![7u8; bytes]).unwrap();
    }

    #[test]
    fn totals_roll_up_and_hard_links_count_once() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(&root.join("a/one.bin"), 2 * 1024 * 1024);
        write(&root.join("a/b/two.txt"), 10_000);
        write(&root.join("c/.hidden"), 100);
        #[cfg(unix)]
        fs::hard_link(root.join("a/one.bin"), root.join("c/link.bin")).unwrap();

        let progress = Progress::default();
        let data = scan(root, &progress, &AtomicBool::new(false)).unwrap();
        let by_path: HashMap<_, _> = data.folders.iter().map(|f| (f.path.clone(), f)).collect();
        let root_folder = by_path[&root.to_string_lossy().into_owned()];
        let a = by_path[&root.join("a").to_string_lossy().into_owned()];

        assert_eq!(data.folders.len(), 4);
        // a/one.bin sorts before c/link.bin, so a gets the bytes, every time.
        assert!(a.total_size >= 2 * 1024 * 1024 + 10_000);
        assert_eq!(a.file_count, 2);
        #[cfg(unix)]
        {
            assert_eq!(root_folder.file_count, 4, "the hard link is still a file");
            assert_eq!(root_folder.total_size, data.total_size);
            // ...but its bytes are only counted once.
            let c = by_path[&root.join("c").to_string_lossy().into_owned()];
            assert!(c.total_size < 1024 * 1024);
        }
        assert_eq!(data.extensions[".bin"].0, 1);
        assert_eq!(data.extensions[""].0, 1, ".hidden has no extension");
        // The hard link is the same file, not a duplicate to report.
        assert_eq!(data.large_files.len(), 1);
        assert_eq!(progress.percent(), 95);
    }

    #[test]
    fn cancelled_scan_returns_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan(tmp.path(), &Progress::default(), &AtomicBool::new(true)).is_none());
    }

    #[test]
    fn extension_matches_python_splitext() {
        assert_eq!(extension_of("a.TXT"), ".txt");
        assert_eq!(extension_of("archive.tar.gz"), ".gz");
        assert_eq!(extension_of(".bashrc"), "");
        assert_eq!(extension_of("noext"), "");
        assert_eq!(extension_of("trailing."), ".");
    }
}
