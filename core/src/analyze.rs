//! Findings: what in a scan is worth a look.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::scan::{Folder, ScanData};
use crate::util::now_secs;

const GB: f64 = 1024.0 * 1024.0 * 1024.0;
const MB: f64 = 1024.0 * 1024.0;
const LARGE_FOLDER: u64 = 1024 * 1024 * 1024;
const OLD_DAYS: i64 = 365;
const RECENT_DAYS: i64 = 7;
const TOP_N_LARGE: usize = 20;

/// Folder names that hold caches, build output or other things that come back
/// on their own.
const CACHE_FOLDER_PATTERNS: &[&str] = &[
    "node_modules",
    ".cache",
    "__pycache__",
    "dist",
    "build",
    "out",
    "tmp",
    "temp",
    ".tmp",
    ".temp",
    "cache",
    ".git",
    ".venv",
    "venv",
    "env",
    ".env",
    ".next",
    ".nuxt",
    "target",
    "bin",
    "obj",
    ".ds_store",
    ".appledouble",
    ".lsoverride",
    ".documentrevisions-v100",
    ".fseventsd",
    ".spotlight-v100",
    ".temporaryitems",
    ".trashes",
    ".volumeicon.icns",
    ".com.apple.timemachine.donotpresent",
    ".appledb",
    ".appledesktop",
    "network trash folder",
    "temporary items",
    ".apdisk",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Finding {
    pub id: String,
    pub category: String,
    pub reason: String,
    pub paths: Vec<String>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExtensionSummary {
    pub extension: String,
    pub file_count: u64,
    pub total_bytes: u64,
}

fn name_of(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn days_since(secs: f64, now: f64) -> i64 {
    ((now - secs) / 86_400.0).floor() as i64
}

struct Findings {
    list: Vec<Finding>,
}

impl Findings {
    fn push(&mut self, category: &str, reason: String, paths: Vec<String>, total_bytes: u64) {
        let id = format!("finding-{}", self.list.len() + 1);
        self.list.push(Finding { id, category: category.into(), reason, paths, total_bytes });
    }
}

/// Run every heuristic over a scan.
pub fn analyze(data: &ScanData) -> Vec<Finding> {
    let now = now_secs();
    let mut out = Findings { list: Vec::new() };
    large_folders(&data.folders, &mut out);
    old_large_folders(&data.folders, now, &mut out);
    cache_candidates(&data.folders, &mut out);
    duplicate_folders(&data.folders, &mut out);
    duplicate_files(&data.large_files, &mut out);
    cold_archives(&data.folders, now, &mut out);
    out.list
}

fn large_folders(folders: &[Folder], out: &mut Findings) {
    let mut large: Vec<&Folder> = folders.iter().filter(|f| f.total_size >= LARGE_FOLDER).collect();
    large.sort_by_key(|f| std::cmp::Reverse(f.total_size));
    for f in large.into_iter().take(TOP_N_LARGE) {
        out.push(
            "large_folder",
            format!("Folder is {:.1} GB ({} files)", f.total_size as f64 / GB, f.file_count),
            vec![f.path.clone()],
            f.total_size,
        );
    }
}

fn old_large_folders(folders: &[Folder], now: f64, out: &mut Findings) {
    for f in folders {
        if f.total_size < LARGE_FOLDER || f.last_modified == 0.0 {
            continue;
        }
        let days = days_since(f.last_modified, now);
        let size_gb = f.total_size as f64 / GB;
        if days > OLD_DAYS {
            out.push(
                "old_large_folder",
                format!("Folder is {size_gb:.1} GB and last modified {days} days ago"),
                vec![f.path.clone()],
                f.total_size,
            );
        } else if days <= RECENT_DAYS && f.total_size >= LARGE_FOLDER * 2 {
            out.push(
                "active_large_folder",
                format!("Folder is {size_gb:.1} GB and was modified within the last {days} days"),
                vec![f.path.clone()],
                f.total_size,
            );
        }
    }
}

/// Folders named like a cache. Only the outermost match counts: a
/// node_modules inside a node_modules is already inside the first one.
fn cache_candidates(folders: &[Folder], out: &mut Findings) {
    let mut matched: HashSet<&str> = HashSet::new();
    // Folders are sorted by path, but a parent always sorts before its own
    // children, so walking up the parents finds any matched ancestor.
    for f in folders {
        if !CACHE_FOLDER_PATTERNS.contains(&name_of(&f.path).as_str()) {
            continue;
        }
        let nested = Path::new(&f.path)
            .ancestors()
            .skip(1)
            .any(|a| matched.contains(a.to_string_lossy().as_ref()));
        matched.insert(&f.path);
        if nested || f.total_size == 0 {
            continue;
        }
        out.push(
            "cache_candidate",
            format!("Matches known cache/regenerable pattern ({:.1} MB)", f.total_size as f64 / MB),
            vec![f.path.clone()],
            f.total_size,
        );
    }
}

/// Folders with the same name and sizes within 10% of each other.
fn duplicate_folders(folders: &[Folder], out: &mut Findings) {
    let mut by_name: Vec<(String, Vec<&Folder>)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for f in folders {
        let name = name_of(&f.path);
        if name.is_empty() || f.total_size <= 10 * 1024 * 1024 {
            continue;
        }
        let slot = *index.entry(name.clone()).or_insert_with(|| {
            by_name.push((name, Vec::new()));
            by_name.len() - 1
        });
        by_name[slot].1.push(f);
    }
    for (name, mut candidates) in by_name {
        if candidates.len() < 2 {
            continue;
        }
        candidates.sort_by_key(|f| std::cmp::Reverse(f.total_size));
        let mut groups: Vec<Vec<&Folder>> = Vec::new();
        for f in candidates {
            let home = groups.iter_mut().find(|g| {
                let reference = g[0].total_size;
                reference > 0 && (f.total_size.abs_diff(reference) as f64 / reference as f64) <= 0.10
            });
            match home {
                Some(group) => group.push(f),
                None => groups.push(vec![f]),
            }
        }
        for group in groups.into_iter().filter(|g| g.len() >= 2) {
            let total: u64 = group.iter().map(|f| f.total_size).sum();
            // Everything but one copy could go.
            let reclaimable = total - group[0].total_size;
            out.push(
                "duplicate_folder_candidate",
                format!("{} folders named '{}' with similar sizes", group.len(), name),
                group.iter().map(|f| f.path.clone()).collect(),
                reclaimable,
            );
        }
    }
}

/// Files over 1 MB with the same name and size.
fn duplicate_files(large_files: &[(String, u64)], out: &mut Findings) {
    let mut groups: Vec<((String, u64), Vec<String>)> = Vec::new();
    let mut index: HashMap<(String, u64), usize> = HashMap::new();
    for (path, size) in large_files {
        if *size <= 1024 * 1024 {
            continue;
        }
        let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let key = (name, *size);
        let slot = *index.entry(key.clone()).or_insert_with(|| {
            groups.push((key, Vec::new()));
            groups.len() - 1
        });
        groups[slot].1.push(path.clone());
    }
    for ((name, size), paths) in groups {
        if paths.len() < 2 {
            continue;
        }
        let reclaimable = size * (paths.len() as u64 - 1);
        out.push(
            "duplicate_file_candidate",
            format!("{} files named '{}' ({:.1} MB each)", paths.len(), name, size as f64 / MB),
            paths,
            reclaimable,
        );
    }
}

fn cold_archives(folders: &[Folder], now: f64, out: &mut Findings) {
    for f in folders {
        if f.total_size < LARGE_FOLDER || f.last_accessed == 0.0 {
            continue;
        }
        let days = days_since(f.last_accessed, now);
        if days > OLD_DAYS {
            out.push(
                "cold_archive_candidate",
                format!("{:.1} GB, not accessed in {} days", f.total_size as f64 / GB, days),
                vec![f.path.clone()],
                f.total_size,
            );
        }
    }
}

/// Bytes and file counts by extension, biggest first.
pub fn extension_summary(data: &ScanData) -> Vec<ExtensionSummary> {
    let mut rows: Vec<ExtensionSummary> = data
        .extensions
        .iter()
        .map(|(ext, (count, bytes))| ExtensionSummary {
            extension: if ext.is_empty() { "(no extension)".into() } else { ext.clone() },
            file_count: *count,
            total_bytes: *bytes,
        })
        .collect();
    rows.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes).then_with(|| a.extension.cmp(&b.extension)));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(path: &str, size: u64, modified_days_ago: f64) -> Folder {
        let t = now_secs() - modified_days_ago * 86_400.0;
        Folder { path: path.into(), total_size: size, file_count: 3, last_modified: t, last_accessed: t }
    }

    #[test]
    fn nested_caches_are_reported_once() {
        let data = ScanData {
            folders: vec![
                folder("/p/app", 600, 1.0),
                folder("/p/app/node_modules", 500, 1.0),
                folder("/p/app/node_modules/x/node_modules", 200, 1.0),
                folder("/p/app/templates", 10, 1.0),
            ],
            ..Default::default()
        };
        let found = analyze(&data);
        let caches: Vec<_> = found.iter().filter(|f| f.category == "cache_candidate").collect();
        assert_eq!(caches.len(), 1);
        assert_eq!(caches[0].paths, vec!["/p/app/node_modules"]);
    }

    #[test]
    fn large_old_and_duplicate_findings() {
        let g = LARGE_FOLDER;
        let data = ScanData {
            folders: vec![
                folder("/d/old", 2 * g, 400.0),
                folder("/d/new", 3 * g, 2.0),
                folder("/d/a/photos", 100 * 1024 * 1024, 30.0),
                folder("/d/b/photos", 95 * 1024 * 1024, 30.0),
            ],
            large_files: vec![("/d/x/movie.mp4".into(), 5_000_000), ("/d/y/movie.mp4".into(), 5_000_000)],
            ..Default::default()
        };
        let found = analyze(&data);
        let cats: Vec<&str> = found.iter().map(|f| f.category.as_str()).collect();
        assert_eq!(cats.iter().filter(|c| **c == "large_folder").count(), 2);
        assert!(cats.contains(&"old_large_folder"));
        assert!(cats.contains(&"active_large_folder"));
        assert!(cats.contains(&"cold_archive_candidate"));
        let dup = found.iter().find(|f| f.category == "duplicate_folder_candidate").unwrap();
        assert_eq!(dup.total_bytes, 95 * 1024 * 1024);
        let dup_files = found.iter().find(|f| f.category == "duplicate_file_candidate").unwrap();
        assert_eq!(dup_files.reason, "2 files named 'movie.mp4' (4.8 MB each)");
        assert_eq!(found[0].reason, "Folder is 3.0 GB (3 files)");
    }
}
