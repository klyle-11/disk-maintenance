//! The disk scanner.
//!
//! Walks a tree in parallel (one rayon task per directory) and keeps only
//! per-folder and per-extension totals, plus individual files of at least
//! [`LARGE_FILE_THRESHOLD`] for duplicate detection, so memory scales with the
//! number of folders rather than files. Sizes are on-disk bytes from lstat
//! (symlinks are not followed) and a hard-linked file is counted once.

use crate::paths::should_ignore;
use crate::util::{atime, disk_usage_bytes, extension_of, hardlink_key, mtime};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Files at least this big are remembered individually.
pub const LARGE_FILE_THRESHOLD: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FolderStats {
    pub total_size: u64,
    pub file_count: u64,
    /// Newest file mtime / atime beneath the folder (epoch seconds, 0 = none).
    pub last_modified: f64,
    pub last_accessed: f64,
}

#[derive(Debug, Default)]
pub struct ScanData {
    pub root: String,
    /// Folder path -> totals for its whole subtree.
    pub folders: HashMap<String, FolderStats>,
    /// Extension (".txt", "" for none) -> (file count, bytes).
    pub extensions: HashMap<String, (u64, u64)>,
    /// (path, apparent size) for files >= LARGE_FILE_THRESHOLD.
    pub large_files: Vec<(String, u64)>,
    pub total_files: u64,
    pub total_size: u64,
}

#[derive(Debug, Clone)]
pub struct ScanProgress {
    pub files_scanned: u64,
    pub folders_scanned: u64,
    pub bytes_scanned: u64,
    pub current_path: String,
    /// Depth of `current_path` below the scan root.
    pub depth: usize,
    pub elapsed: Duration,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Cancelled;

/// One directory's own files (not its subfolders).
struct DirRecord {
    path: String,
    depth: usize,
    own: FolderStats,
    extensions: HashMap<String, (u64, u64)>,
    large_files: Vec<(String, u64)>,
}

struct Ctx<'a> {
    cancel: &'a AtomicBool,
    seen_inodes: Mutex<HashSet<(u64, u64)>>,
    files: AtomicU64,
    bytes: AtomicU64,
}

const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// Scan `root`. `on_progress` is called on the calling thread about four
/// times a second. Returns `Err(Cancelled)` once `cancel` is set.
pub fn scan(
    root: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(&ScanProgress),
) -> Result<ScanData, Cancelled> {
    let started = Instant::now();
    let root_key = root.to_string_lossy().into_owned();
    let (tx, rx) = mpsc::channel::<DirRecord>();
    let ctx = Ctx {
        cancel,
        seen_inodes: Mutex::new(HashSet::new()),
        files: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
    };

    let mut data = ScanData { root: root_key.clone(), ..Default::default() };

    std::thread::scope(|scope| {
        let ctx = &ctx;
        // The walker owns the sender, so the channel closes the moment the
        // walk is done.
        scope.spawn(move || {
            let tx = &tx;
            rayon::scope(|s| walk_dir(s, root.to_path_buf(), 0, ctx, tx));
        });

        let mut last_emit = Instant::now();
        let mut last = (String::new(), 0usize);
        loop {
            match rx.recv_timeout(PROGRESS_INTERVAL) {
                Ok(record) => {
                    last = (record.path.clone(), record.depth);
                    absorb(&mut data, record);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if last_emit.elapsed() >= PROGRESS_INTERVAL && !cancel.load(Ordering::Relaxed) {
                on_progress(&ScanProgress {
                    files_scanned: ctx.files.load(Ordering::Relaxed),
                    folders_scanned: data.folders.len() as u64,
                    bytes_scanned: ctx.bytes.load(Ordering::Relaxed),
                    current_path: last.0.clone(),
                    depth: last.1,
                    elapsed: started.elapsed(),
                });
                last_emit = Instant::now();
            }
        }
    });

    if cancel.load(Ordering::Relaxed) {
        return Err(Cancelled);
    }

    propagate(&mut data.folders);
    let root_stats = data.folders.get(&root_key).copied().unwrap_or_default();
    data.total_files = root_stats.file_count;
    data.total_size = root_stats.total_size;
    Ok(data)
}

fn absorb(data: &mut ScanData, record: DirRecord) {
    data.folders.insert(record.path, record.own);
    for (ext, (count, bytes)) in record.extensions {
        let e = data.extensions.entry(ext).or_default();
        e.0 += count;
        e.1 += bytes;
    }
    data.large_files.extend(record.large_files);
}

fn walk_dir<'s>(
    s: &rayon::Scope<'s>,
    dir: PathBuf,
    depth: usize,
    ctx: &'s Ctx<'s>,
    tx: &'s mpsc::Sender<DirRecord>,
) {
    if ctx.cancel.load(Ordering::Relaxed) {
        return;
    }
    let mut record = DirRecord {
        path: dir.to_string_lossy().into_owned(),
        depth,
        own: FolderStats::default(),
        extensions: HashMap::new(),
        large_files: Vec::new(),
    };
    let mut subdirs = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            let path = entry.path();
            if file_type.is_dir() {
                if !should_ignore(&path) {
                    subdirs.push(path);
                }
                continue;
            }
            // A link to a directory is neither walked nor counted (as with
            // os.walk); a link to anything else counts as its own small file.
            if file_type.is_symlink() && fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false) {
                continue;
            }
            // DirEntry::metadata does not follow symlinks.
            let Ok(md) = entry.metadata() else { continue };
            add_file(&mut record, &path, &entry.file_name().to_string_lossy(), &md, ctx);
        }
    }

    let _ = tx.send(record);
    for sub in subdirs {
        s.spawn(move |s| walk_dir(s, sub, depth + 1, ctx, tx));
    }
}

fn add_file(record: &mut DirRecord, path: &Path, name: &str, md: &fs::Metadata, ctx: &Ctx) {
    record.own.file_count += 1;
    ctx.files.fetch_add(1, Ordering::Relaxed);

    if let Some(key) = hardlink_key(md) {
        if !ctx.seen_inodes.lock().unwrap().insert(key) {
            return;
        }
    }

    let size = disk_usage_bytes(md);
    record.own.total_size += size;
    ctx.bytes.fetch_add(size, Ordering::Relaxed);
    record.own.last_modified = record.own.last_modified.max(mtime(md));
    record.own.last_accessed = record.own.last_accessed.max(atime(md));

    let ext = record.extensions.entry(extension_of(name)).or_default();
    ext.0 += 1;
    ext.1 += size;

    if md.len() >= LARGE_FILE_THRESHOLD {
        record.large_files.push((path.to_string_lossy().into_owned(), md.len()));
    }
}

/// Fold every folder's totals into its ancestors, deepest first.
fn propagate(folders: &mut HashMap<String, FolderStats>) {
    let mut paths: Vec<(usize, String)> = folders
        .keys()
        .map(|p| (Path::new(p).components().count(), p.clone()))
        .collect();
    paths.sort_unstable_by_key(|p| std::cmp::Reverse(p.0));

    for (_, path) in paths {
        let Some(parent) = Path::new(&path).parent().map(|p| p.to_string_lossy().into_owned()) else {
            continue;
        };
        if parent == path {
            continue;
        }
        let child = folders[&path];
        if let Some(par) = folders.get_mut(&parent) {
            par.total_size += child.total_size;
            par.file_count += child.file_count;
            par.last_modified = par.last_modified.max(child.last_modified);
            par.last_accessed = par.last_accessed.max(child.last_accessed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn write(path: &Path, bytes: usize) {
        let mut f = File::create(path).unwrap();
        f.write_all(&vec![b'x'; bytes]).unwrap();
    }

    #[test]
    fn aggregates_folders_and_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("a/b")).unwrap();
        write(&root.join("top.txt"), 10);
        write(&root.join("a/one.TXT"), 5000);
        write(&root.join("a/b/big.bin"), 2 * 1024 * 1024);

        let cancel = AtomicBool::new(false);
        let data = scan(root, &cancel, |_| {}).unwrap();

        assert_eq!(data.total_files, 3);
        assert_eq!(data.folders.len(), 3);
        let a = data.folders[&root.join("a").to_string_lossy().into_owned()];
        assert_eq!(a.file_count, 2);
        assert!(a.total_size >= 2 * 1024 * 1024);
        assert_eq!(data.total_size, data.folders[&data.root].total_size);
        assert_eq!(data.extensions[".txt"].0, 2);
        assert_eq!(data.extensions[".bin"].0, 1);
        assert_eq!(data.large_files.len(), 1);
        assert!(data.large_files[0].0.ends_with("big.bin"));
    }

    #[cfg(unix)]
    #[test]
    fn counts_hard_links_once_and_skips_dir_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("d")).unwrap();
        write(&root.join("d/f"), 64 * 1024);
        fs::hard_link(root.join("d/f"), root.join("d/f2")).unwrap();
        std::os::unix::fs::symlink(root.join("d"), root.join("loop")).unwrap();

        let cancel = AtomicBool::new(false);
        let data = scan(root, &cancel, |_| {}).unwrap();
        let d = data.folders[&root.join("d").to_string_lossy().into_owned()];
        assert_eq!(d.file_count, 2);
        let single = disk_usage_bytes(&fs::metadata(root.join("d/f")).unwrap());
        assert_eq!(data.total_size, single);
        assert!(!data.folders.contains_key(&root.join("loop").to_string_lossy().into_owned()));
    }

    #[test]
    fn cancel_stops_the_scan() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(true);
        assert!(scan(dir.path(), &cancel, |_| {}).is_err());
    }
}
