//! du-hast-much: the size of each folder directly under a root, reported as
//! each one finishes.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use rayon::prelude::*;
use serde::Serialize;

use crate::util::epoch_secs;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DhmResult {
    pub name: String,
    pub path: String,
    /// Apparent bytes (file sizes, as `du --apparent-size` counts them).
    pub size: u64,
    pub files: u64,
    pub latest_mtime: f64,
    pub avg_file_size: f64,
}

#[derive(Default)]
struct Tally {
    size: u64,
    files: u64,
    latest: f64,
}

fn walk(dir: &Path, exclude: &HashSet<String>, cancel: &AtomicBool, tally: &mut Tally) {
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if !exclude.contains(&entry.file_name().to_string_lossy().into_owned()) {
                walk(&entry.path(), exclude, cancel, tally);
            }
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        tally.size += meta.len();
        tally.latest = tally.latest.max(epoch_secs(meta.modified()));
        // A symlink's own size counts, but it isn't a file.
        if !kind.is_symlink() {
            tally.files += 1;
        }
    }
}

/// Size up every folder directly under `root` (in parallel), calling
/// `on_result` as each finishes. Returns them all.
pub fn scan<F>(root: &Path, exclude: &[String], cancel: &AtomicBool, on_result: F) -> Vec<DhmResult>
where
    F: Fn(&DhmResult) + Sync,
{
    let exclude: HashSet<String> = exclude.iter().cloned().collect();
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let dirs: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !exclude.contains(&e.file_name().to_string_lossy().into_owned()))
        .collect();
    dirs.par_iter()
        .filter_map(|entry| {
            let mut tally = Tally::default();
            walk(&entry.path(), &exclude, cancel, &mut tally);
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let result = DhmResult {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                size: tally.size,
                files: tally.files,
                latest_mtime: tally.latest,
                avg_file_size: if tally.files > 0 { tally.size as f64 / tally.files as f64 } else { 0.0 },
            };
            on_result(&result);
            Some(result)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn sizes_each_top_level_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("big/inner")).unwrap();
        fs::write(root.join("big/inner/a.bin"), vec![0u8; 3000]).unwrap();
        fs::write(root.join("big/b.txt"), "hello").unwrap();
        fs::create_dir_all(root.join("skipme")).unwrap();
        fs::write(root.join("skipme/x"), "x").unwrap();
        fs::write(root.join("loose-file"), "not a folder").unwrap();

        let seen = Mutex::new(Vec::new());
        let results = scan(root, &["skipme".to_string()], &AtomicBool::new(false), |r| seen.lock().unwrap().push(r.name.clone()));
        assert_eq!(results.len(), 1);
        assert_eq!(seen.into_inner().unwrap(), vec!["big"]);
        assert_eq!((results[0].size, results[0].files), (3005, 2));
        assert!(results[0].latest_mtime > 0.0);
    }
}
