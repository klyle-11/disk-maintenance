//! du-hast-much: the size of each folder directly under a path.

use crate::model::DuHastMuchResult;
use crate::util::mtime;
use rayon::prelude::*;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[derive(Default)]
struct Tally {
    size: u64,
    files: u64,
    latest_mtime: f64,
}

/// Apparent size of everything under `dir`. Symlinks count as themselves and
/// are never followed; folders named in `exclude` are skipped.
fn walk(dir: &Path, exclude: &HashSet<String>, cancel: &AtomicBool, tally: &mut Tally) {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_dir() {
                if !exclude.contains(&*entry.file_name().to_string_lossy()) {
                    stack.push(entry.path());
                }
                continue;
            }
            let Ok(md) = entry.metadata() else { continue };
            if !file_type.is_symlink() {
                tally.files += 1;
            }
            tally.size += md.len();
            tally.latest_mtime = tally.latest_mtime.max(mtime(&md));
        }
    }
}

/// Size every folder directly under `root`, in parallel. `on_result` is
/// called as each one finishes (from worker threads). Returns all results,
/// or `None` if cancelled.
pub fn scan_directory(
    root: &Path,
    exclude: &[String],
    cancel: &AtomicBool,
    on_result: &(dyn Fn(&DuHastMuchResult) + Sync),
) -> Option<Vec<DuHastMuchResult>> {
    let exclude: HashSet<String> = exclude.iter().cloned().collect();
    let Ok(entries) = fs::read_dir(root) else { return Some(Vec::new()) };
    let dirs: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !exclude.contains(&*e.file_name().to_string_lossy()))
        .collect();

    let results = Mutex::new(Vec::with_capacity(dirs.len()));
    dirs.par_iter().for_each(|entry| {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let mut tally = Tally::default();
        walk(&entry.path(), &exclude, cancel, &mut tally);
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let result = DuHastMuchResult {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            size: tally.size,
            files: tally.files,
            latest_mtime: tally.latest_mtime,
            avg_file_size: if tally.files > 0 { tally.size as f64 / tally.files as f64 } else { 0.0 },
        };
        on_result(&result);
        results.lock().unwrap().push(result);
    });

    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    Some(results.into_inner().unwrap())
}

/// Order results the way the UI asked for: newest first, or largest first.
pub fn sort_and_limit(results: &mut Vec<DuHastMuchResult>, latest: bool, top: Option<usize>) {
    if latest {
        results.sort_by(|a, b| b.latest_mtime.total_cmp(&a.latest_mtime));
    } else {
        results.sort_by_key(|r| std::cmp::Reverse(r.size));
    }
    if let Some(top) = top.filter(|t| *t > 0) {
        results.truncate(top);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_each_top_level_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("big/inner")).unwrap();
        fs::create_dir_all(root.join("small")).unwrap();
        fs::create_dir_all(root.join("skipme")).unwrap();
        fs::write(root.join("big/inner/a"), vec![0u8; 3000]).unwrap();
        fs::write(root.join("big/b"), vec![0u8; 1000]).unwrap();
        fs::write(root.join("small/c"), vec![0u8; 10]).unwrap();
        fs::write(root.join("skipme/d"), vec![0u8; 99999]).unwrap();
        fs::write(root.join("loose-file"), vec![0u8; 5]).unwrap();

        let seen = Mutex::new(0);
        let cancel = AtomicBool::new(false);
        let mut results = scan_directory(root, &["skipme".into()], &cancel, &|_| {
            *seen.lock().unwrap() += 1;
        })
        .unwrap();
        sort_and_limit(&mut results, false, None);

        assert_eq!(*seen.lock().unwrap(), 2);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].name, "big");
        assert_eq!(results[0].size, 4000);
        assert_eq!(results[0].files, 2);
        assert_eq!(results[0].avg_file_size, 2000.0);
        assert_eq!(results[1].name, "small");

        sort_and_limit(&mut results, false, Some(1));
        assert_eq!(results.len(), 1);
    }
}
