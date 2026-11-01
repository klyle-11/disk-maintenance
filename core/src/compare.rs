//! Comparing two folder trees (mirror or backup checks).

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::util::{epoch_secs, local_iso, should_ignore};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComparisonItem {
    pub name: String,
    pub relative_path: String,
    /// "file" or "folder"
    pub item_type: String,
    /// "identical", "modified", "missing_from_target" or "extra_in_target"
    pub status: String,
    pub source_size: Option<u64>,
    pub target_size: Option<u64>,
    pub source_modified: Option<String>,
    pub target_modified: Option<String>,
    pub source_hash: Option<String>,
    pub target_hash: Option<String>,
    pub children: Option<Vec<ComparisonItem>>,
    /// For folders: how many differences are inside, at any depth.
    pub difference_count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ComparisonSummary {
    pub identical: u64,
    pub modified: u64,
    pub missing_from_target: u64,
    pub extra_in_target: u64,
    pub total_source_size: u64,
    pub total_target_size: u64,
}

struct Entry {
    full_path: PathBuf,
    size: u64,
    modified: String,
    is_dir: bool,
}

/// Every file and folder under `root`, by relative path ("/"-separated).
fn index(root: &Path) -> BTreeMap<String, Entry> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            // Follow symlinks for what they point at, but never walk into one.
            let Ok(meta) = fs::metadata(&path) else { continue };
            let is_dir = meta.is_dir();
            if is_dir && should_ignore(&path) {
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else { continue };
            let key = relative.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            out.insert(
                key,
                Entry {
                    size: if is_dir { 0 } else { meta.len() },
                    modified: local_iso(epoch_secs(meta.modified())),
                    full_path: path.clone(),
                    is_dir,
                },
            );
            if is_dir && !kind.is_symlink() {
                stack.push(path);
            }
        }
    }
    out
}

fn sha256(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn compare_files(source: &Entry, target: &Entry, deep: bool) -> &'static str {
    if source.size != target.size {
        return "modified";
    }
    if deep {
        // Same size: the contents decide, whatever the dates say.
        return match (sha256(&source.full_path), sha256(&target.full_path)) {
            (Some(a), Some(b)) if a == b => "identical",
            (Some(_), Some(_)) => "modified",
            // Unreadable: fall back to the dates.
            _ if source.modified == target.modified => "identical",
            _ => "modified",
        };
    }
    if source.modified != target.modified {
        "modified"
    } else {
        "identical"
    }
}

/// Compare two trees. Returns the tree of top-level items and a summary.
pub fn compare(source: &Path, target: &Path, deep: bool) -> (Vec<ComparisonItem>, ComparisonSummary) {
    let (source_index, target_index) = rayon::join(|| index(source), || index(target));
    let mut summary = ComparisonSummary::default();

    let mut paths: Vec<&String> = source_index.keys().chain(target_index.keys()).collect();
    paths.sort();
    paths.dedup();

    let mut items: BTreeMap<String, ComparisonItem> = BTreeMap::new();
    for rel in paths {
        let s = source_index.get(rel);
        let t = target_index.get(rel);
        let is_dir = s.map(|e| e.is_dir).unwrap_or(false) || t.map(|e| e.is_dir).unwrap_or(false);
        let status = match (s, t) {
            (Some(_), Some(_)) if is_dir => "identical",
            (Some(a), Some(b)) => compare_files(a, b, deep),
            (Some(_), None) => "missing_from_target",
            _ => "extra_in_target",
        };
        if !is_dir {
            match status {
                "identical" => summary.identical += 1,
                "modified" => summary.modified += 1,
                "missing_from_target" => summary.missing_from_target += 1,
                _ => summary.extra_in_target += 1,
            }
        }
        summary.total_source_size += s.map(|e| e.size).unwrap_or(0);
        summary.total_target_size += t.map(|e| e.size).unwrap_or(0);
        items.insert(
            rel.clone(),
            ComparisonItem {
                name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
                relative_path: rel.clone(),
                item_type: if is_dir { "folder" } else { "file" }.into(),
                status: status.into(),
                source_size: s.map(|e| e.size),
                target_size: t.map(|e| e.size),
                source_modified: s.map(|e| e.modified.clone()),
                target_modified: t.map(|e| e.modified.clone()),
                source_hash: None,
                target_hash: None,
                children: is_dir.then(Vec::new),
                difference_count: 0,
            },
        );
    }

    // Hang each item on its parent, deepest first, so a folder's difference
    // count is complete before it is added to its own parent.
    let mut keys: Vec<String> = items.keys().cloned().collect();
    keys.sort_by_key(|k| std::cmp::Reverse(k.matches('/').count()));
    let mut roots = Vec::new();
    for key in keys {
        let item = items.remove(&key).expect("each key once");
        let parent_key = key.rsplit_once('/').map(|(p, _)| p.to_string());
        match parent_key.as_ref().and_then(|p| items.get_mut(p)) {
            Some(parent) => {
                if item.status != "identical" || item.difference_count > 0 {
                    parent.difference_count += 1 + item.difference_count;
                    if parent.status == "identical" {
                        parent.status = "modified".into();
                    }
                }
                parent.children.get_or_insert_with(Vec::new).push(item);
            }
            None => roots.push(item),
        }
    }
    sort_tree(&mut roots);
    (roots, summary)
}

fn sort_tree(items: &mut [ComparisonItem]) {
    items.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    for item in items {
        if let Some(children) = item.children.as_mut() {
            sort_tree(children);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn statuses_summary_and_deep_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        write(&a.join("same.txt"), "x");
        write(&b.join("same.txt"), "x");
        write(&a.join("src/deep/main.py"), "one");
        write(&b.join("src/deep/main.py"), "two!");
        write(&a.join("docs/only.md"), "o");
        write(&b.join("extra.png"), "e");
        // Same content, different times: identical only on a deep check.
        let t = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::File::options().write(true).open(a.join("same.txt")).unwrap().set_modified(t).unwrap();

        let (tree, summary) = compare(&a, &b, false);
        assert_eq!((summary.identical, summary.modified, summary.missing_from_target, summary.extra_in_target), (0, 2, 1, 1));
        let src = tree.iter().find(|i| i.name == "src").unwrap();
        assert_eq!(src.status, "modified", "a change two levels down reaches the top");
        assert_eq!(src.difference_count, 2);
        assert_eq!(tree.iter().find(|i| i.name == "docs").unwrap().status, "missing_from_target");

        let (_, deep) = compare(&a, &b, true);
        assert_eq!((deep.identical, deep.modified), (1, 1));
    }
}
