//! Findings: heuristics over a finished scan.

use crate::model::{ExtensionSummary, Finding};
use crate::scanner::{FolderStats, ScanData};
use crate::util::now_secs;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

const GB: f64 = 1024.0 * 1024.0 * 1024.0;
const MB: f64 = 1024.0 * 1024.0;
const LARGE_FOLDER_THRESHOLD: u64 = 1024 * 1024 * 1024;
const OLD_DAYS_THRESHOLD: i64 = 365;
const RECENT_DAYS_THRESHOLD: i64 = 7;
const TOP_N_LARGE: usize = 20;
const DUPLICATE_FOLDER_MIN: u64 = 10 * 1024 * 1024;
const DUPLICATE_FILE_MIN: u64 = 1024 * 1024;

/// Folder names that hold caches or regenerable build output.
const CACHE_FOLDER_PATTERNS: &[&str] = &[
    "node_modules", ".cache", "__pycache__", "dist", "build", "out", "tmp", "temp", ".tmp",
    ".temp", "cache", ".git", ".venv", "venv", "env", ".env", ".next", ".nuxt", "target", "bin",
    "obj", ".DS_Store", ".AppleDouble", ".LSOverride", ".DocumentRevisions-V100", ".fseventsd",
    ".Spotlight-V100", ".TemporaryItems", ".Trashes", ".VolumeIcon.icns",
    ".com.apple.timemachine.donotpresent", ".AppleDB", ".AppleDesktop", "Network Trash Folder",
    "Temporary Items", ".apdisk",
];

fn name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn days_since(ts: f64, now: f64) -> i64 {
    ((now - ts) / 86400.0).floor() as i64
}

pub struct Analyzer<'a> {
    data: &'a ScanData,
    /// Folders in path order, so findings come out in a stable order.
    folders: Vec<(&'a str, &'a FolderStats)>,
    findings: Vec<Finding>,
    now: f64,
}

impl<'a> Analyzer<'a> {
    pub fn new(data: &'a ScanData) -> Self {
        let mut folders: Vec<_> = data.folders.iter().map(|(p, s)| (p.as_str(), s)).collect();
        folders.sort_unstable_by(|a, b| a.0.cmp(b.0));
        Analyzer { data, folders, findings: Vec::new(), now: now_secs() }
    }

    pub fn analyze(mut self) -> Vec<Finding> {
        self.large_folders();
        self.old_large_folders();
        self.cache_candidates();
        self.duplicate_folder_candidates();
        self.duplicate_file_candidates();
        self.cold_archive_candidates();
        self.findings
    }

    fn push(&mut self, category: &str, reason: String, paths: Vec<String>, total_bytes: u64) {
        let id = format!("finding-{}", self.findings.len() + 1);
        self.findings.push(Finding { id, category: category.into(), reason, paths, total_bytes });
    }

    fn large_folders(&mut self) {
        let mut large: Vec<_> = self
            .folders
            .iter()
            .filter(|(_, s)| s.total_size >= LARGE_FOLDER_THRESHOLD)
            .map(|(p, s)| (*p, **s))
            .collect();
        large.sort_by_key(|(_, s)| std::cmp::Reverse(s.total_size));
        for (path, s) in large.into_iter().take(TOP_N_LARGE) {
            let reason = format!(
                "Folder is {:.1} GB ({} files)",
                s.total_size as f64 / GB,
                s.file_count
            );
            self.push("large_folder", reason, vec![path.into()], s.total_size);
        }
    }

    fn old_large_folders(&mut self) {
        let folders = self.folders.clone();
        for (path, s) in folders {
            if s.total_size < LARGE_FOLDER_THRESHOLD || s.last_modified == 0.0 {
                continue;
            }
            let days = days_since(s.last_modified, self.now);
            let gb = s.total_size as f64 / GB;
            if days > OLD_DAYS_THRESHOLD {
                let reason = format!("Folder is {gb:.1} GB and last modified {days} days ago");
                self.push("old_large_folder", reason, vec![path.into()], s.total_size);
            } else if days <= RECENT_DAYS_THRESHOLD && s.total_size >= LARGE_FOLDER_THRESHOLD * 2 {
                let reason = format!(
                    "Folder is {gb:.1} GB and was modified within the last {days} days"
                );
                self.push("active_large_folder", reason, vec![path.into()], s.total_size);
            }
        }
    }

    /// Folders matching a cache pattern or sitting in a tmp/temp folder. Only
    /// the outermost match is reported, so nested matches (node_modules inside
    /// node_modules, everything under /tmp) are not counted twice.
    fn cache_candidates(&mut self) {
        let patterns: HashSet<String> = CACHE_FOLDER_PATTERNS.iter().map(|p| p.to_lowercase()).collect();
        let is_temp_component = |c: &str| {
            let c = c.to_lowercase();
            c == "tmp" || c == "temp"
        };
        let mut reported: Vec<String> = Vec::new();
        let folders = self.folders.clone();
        for (path, s) in folders {
            if s.total_size == 0 {
                continue;
            }
            let p = Path::new(path);
            let is_cache = patterns.contains(&name_of(path).to_lowercase())
                || p.components().any(|c| is_temp_component(&c.as_os_str().to_string_lossy()));
            if !is_cache {
                continue;
            }
            // Folders are visited in path order, so an ancestor match is
            // always reported before its descendants.
            if reported.iter().any(|r| p.starts_with(r)) {
                continue;
            }
            reported.push(path.to_string());
            let reason = format!(
                "Matches known cache/regenerable pattern ({:.1} MB)",
                s.total_size as f64 / MB
            );
            self.push("cache_candidate", reason, vec![path.into()], s.total_size);
        }
    }

    /// Folders with the same name and sizes within 10% of each other.
    fn duplicate_folder_candidates(&mut self) {
        let mut by_name: BTreeMap<String, Vec<(&str, u64)>> = BTreeMap::new();
        for (path, s) in &self.folders {
            let name = name_of(path).to_lowercase();
            if !name.is_empty() && s.total_size > DUPLICATE_FOLDER_MIN {
                by_name.entry(name).or_default().push((path, s.total_size));
            }
        }

        let mut found = Vec::new();
        for (name, mut candidates) in by_name {
            if candidates.len() < 2 {
                continue;
            }
            candidates.sort_by_key(|c| std::cmp::Reverse(c.1));
            let mut groups: Vec<Vec<(&str, u64)>> = Vec::new();
            for (path, size) in candidates {
                let slot = groups.iter_mut().find(|g| {
                    let reference = g[0].1;
                    reference > 0 && (size as f64 - reference as f64).abs() / reference as f64 <= 0.10
                });
                match slot {
                    Some(g) => g.push((path, size)),
                    None => groups.push(vec![(path, size)]),
                }
            }
            for group in groups.into_iter().filter(|g| g.len() >= 2) {
                let total: u64 = group.iter().map(|(_, s)| s).sum();
                // Reclaimable: everything but the largest copy.
                let reclaimable = total - group[0].1;
                let reason = format!("{} folders named '{}' with similar sizes", group.len(), name);
                let paths = group.iter().map(|(p, _)| p.to_string()).collect();
                found.push((reason, paths, reclaimable));
            }
        }
        for (reason, paths, bytes) in found {
            self.push("duplicate_folder_candidate", reason, paths, bytes);
        }
    }

    /// Files over 1 MB with the same name and size.
    fn duplicate_file_candidates(&mut self) {
        let mut by_key: BTreeMap<(String, u64), Vec<String>> = BTreeMap::new();
        for (path, size) in &self.data.large_files {
            if *size > DUPLICATE_FILE_MIN {
                by_key.entry((name_of(path), *size)).or_default().push(path.clone());
            }
        }
        for ((name, size), mut paths) in by_key {
            if paths.len() < 2 {
                continue;
            }
            paths.sort();
            let reason = format!(
                "{} files named '{}' ({:.1} MB each)",
                paths.len(),
                name,
                size as f64 / MB
            );
            let reclaimable = size * (paths.len() as u64 - 1);
            self.push("duplicate_file_candidate", reason, paths, reclaimable);
        }
    }

    fn cold_archive_candidates(&mut self) {
        let folders = self.folders.clone();
        for (path, s) in folders {
            if s.total_size < LARGE_FOLDER_THRESHOLD || s.last_accessed == 0.0 {
                continue;
            }
            let days = days_since(s.last_accessed, self.now);
            if days > OLD_DAYS_THRESHOLD {
                let reason = format!(
                    "{:.1} GB, not accessed in {days} days",
                    s.total_size as f64 / GB
                );
                self.push("cold_archive_candidate", reason, vec![path.into()], s.total_size);
            }
        }
    }
}

/// Files grouped by extension, largest total first.
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
    rows.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes).then(a.extension.cmp(&b.extension)));
    rows
}

/// Count findings by category (handy for logs and tests).
pub fn categories(findings: &[Finding]) -> HashMap<String, usize> {
    let mut out = HashMap::new();
    for f in findings {
        *out.entry(f.category.clone()).or_insert(0) += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(size: u64, mtime: f64) -> FolderStats {
        FolderStats { total_size: size, file_count: 1, last_modified: mtime, last_accessed: mtime }
    }

    fn data(folders: &[(&str, FolderStats)], large: &[(&str, u64)]) -> ScanData {
        ScanData {
            root: "/r".into(),
            folders: folders.iter().map(|(p, s)| (p.to_string(), *s)).collect(),
            large_files: large.iter().map(|(p, s)| (p.to_string(), *s)).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn cache_matches_report_only_the_outermost() {
        let now = now_secs();
        let d = data(
            &[
                ("/r/app/node_modules", folder(50, now)),
                ("/r/app/node_modules/x/node_modules", folder(20, now)),
                ("/r/tmp", folder(30, now)),
                ("/r/tmp/deeper", folder(10, now)),
                ("/r/tmpfiles", folder(10, now)),
            ],
            &[],
        );
        let findings = Analyzer::new(&d).analyze();
        let paths: Vec<_> = findings
            .iter()
            .filter(|f| f.category == "cache_candidate")
            .map(|f| f.paths[0].as_str())
            .collect();
        assert_eq!(paths, vec!["/r/app/node_modules", "/r/tmp"]);
    }

    #[test]
    fn large_old_and_cold_folders() {
        let old = now_secs() - 400.0 * 86400.0;
        let d = data(&[("/r/archive", folder(3 * LARGE_FOLDER_THRESHOLD, old))], &[]);
        let cats = categories(&Analyzer::new(&d).analyze());
        assert_eq!(cats["large_folder"], 1);
        assert_eq!(cats["old_large_folder"], 1);
        assert_eq!(cats["cold_archive_candidate"], 1);
    }

    #[test]
    fn duplicates() {
        let now = now_secs();
        let mb = 1024 * 1024;
        let d = data(
            &[("/r/a/photos", folder(100 * mb, now)), ("/r/b/Photos", folder(95 * mb, now))],
            &[("/r/a/movie.mp4", 5 * mb), ("/r/b/movie.mp4", 5 * mb), ("/r/c/movie.mp4", 6 * mb)],
        );
        let findings = Analyzer::new(&d).analyze();
        let folders = findings.iter().find(|f| f.category == "duplicate_folder_candidate").unwrap();
        assert_eq!(folders.total_bytes, 95 * mb);
        assert_eq!(folders.reason, "2 folders named 'photos' with similar sizes");
        let files = findings.iter().find(|f| f.category == "duplicate_file_candidate").unwrap();
        assert_eq!(files.total_bytes, 5 * mb);
        assert_eq!(files.reason, "2 files named 'movie.mp4' (5.0 MB each)");
        // ids are sequential
        assert!(findings.iter().enumerate().all(|(i, f)| f.id == format!("finding-{}", i + 1)));
    }

    #[test]
    fn extensions_sorted_by_size() {
        let mut d = ScanData::default();
        d.extensions.insert("".into(), (3, 10));
        d.extensions.insert(".mp4".into(), (1, 500));
        let rows = extension_summary(&d);
        assert_eq!(rows[0].extension, ".mp4");
        assert_eq!(rows[1].extension, "(no extension)");
    }
}
