//! Compare two directory trees.

use crate::model::{ComparisonItem, ComparisonStatus, ComparisonSummary};
use crate::paths::should_ignore;
use crate::util::{epoch_to_local_iso, mtime};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

struct Entry {
    full_path: PathBuf,
    size: u64,
    modified: String,
    is_dir: bool,
}

/// Every file and folder under `root`, keyed by relative path.
fn build_index(root: &Path) -> BTreeMap<String, Entry> {
    let mut index = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else { continue };
            // Like os.walk + os.stat: links are followed for their metadata,
            // but linked directories are never descended into.
            let Ok(md) = fs::metadata(&path) else { continue };
            let is_dir = md.is_dir();
            if is_dir && should_ignore(&path) {
                continue;
            }
            let Ok(rel) = path.strip_prefix(root) else { continue };
            index.insert(
                rel.to_string_lossy().into_owned(),
                Entry {
                    full_path: path.clone(),
                    size: if is_dir { 0 } else { md.len() },
                    modified: epoch_to_local_iso(mtime(&md)),
                    is_dir,
                },
            );
            if is_dir && !file_type.is_symlink() {
                stack.push(path);
            }
        }
    }
    index
}

fn hash_file(path: &Path) -> Option<String> {
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
    Some(format!("{:x}", hasher.finalize()))
}

fn compare_files(source: &Entry, target: &Entry, deep: bool) -> ComparisonStatus {
    use ComparisonStatus::*;
    if source.size != target.size {
        return Modified;
    }
    if source.modified != target.modified {
        // Same size, different date: with a deep scan the content decides.
        if deep {
            if let (Some(a), Some(b)) = (hash_file(&source.full_path), hash_file(&target.full_path)) {
                if a == b {
                    return Identical;
                }
            }
        }
        return Modified;
    }
    if deep {
        if let (Some(a), Some(b)) = (hash_file(&source.full_path), hash_file(&target.full_path)) {
            if a != b {
                return Modified;
            }
        }
    }
    Identical
}

/// Compare `source` with `target` and return the tree and summary.
pub fn compare(source: &Path, target: &Path, deep: bool) -> (Vec<ComparisonItem>, ComparisonSummary) {
    let (source_index, target_index) =
        rayon::join(|| build_index(source), || build_index(target));
    let mut summary = ComparisonSummary::default();

    let all: BTreeSet<&String> = source_index.keys().chain(target_index.keys()).collect();
    let mut items: HashMap<String, ComparisonItem> = HashMap::with_capacity(all.len());

    for rel in &all {
        let s = source_index.get(*rel);
        let t = target_index.get(*rel);
        let is_dir = s.is_some_and(|e| e.is_dir) || t.is_some_and(|e| e.is_dir);
        let status = match (s, t) {
            (Some(_), Some(_)) if is_dir => ComparisonStatus::Identical, // settled by children
            (Some(a), Some(b)) => compare_files(a, b, deep),
            (Some(_), None) => ComparisonStatus::MissingFromTarget,
            _ => ComparisonStatus::ExtraInTarget,
        };

        if !is_dir {
            match status {
                ComparisonStatus::Identical => summary.identical += 1,
                ComparisonStatus::Modified => summary.modified += 1,
                ComparisonStatus::MissingFromTarget => summary.missing_from_target += 1,
                ComparisonStatus::ExtraInTarget => summary.extra_in_target += 1,
            }
        }
        summary.total_source_size += s.map_or(0, |e| e.size);
        summary.total_target_size += t.map_or(0, |e| e.size);

        let name = Path::new(rel.as_str())
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        items.insert(
            (*rel).clone(),
            ComparisonItem {
                name,
                relative_path: (*rel).clone(),
                item_type: if is_dir { "folder" } else { "file" }.into(),
                status,
                source_size: s.map(|e| e.size),
                target_size: t.map(|e| e.size),
                source_modified: s.map(|e| e.modified.clone()),
                target_modified: t.map(|e| e.modified.clone()),
                source_hash: None,
                target_hash: None,
                children: if is_dir { Some(Vec::new()) } else { None },
                difference_count: 0,
            },
        );
    }

    // Parent -> children, then assemble bottom-up so every folder's status
    // and difference count reflect everything beneath it.
    let mut children_of: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut roots = Vec::new();
    for rel in &all {
        let parent = Path::new(rel.as_str())
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !parent.is_empty() && items.contains_key(&parent) {
            children_of.entry(parent).or_default().push((*rel).clone());
        } else {
            roots.push((*rel).clone());
        }
    }

    fn assemble(
        rel: &str,
        items: &mut HashMap<String, ComparisonItem>,
        children_of: &BTreeMap<String, Vec<String>>,
    ) -> ComparisonItem {
        let mut item = items.remove(rel).expect("indexed item");
        if let Some(kids) = children_of.get(rel) {
            let mut built = Vec::with_capacity(kids.len());
            for kid in kids {
                let child = assemble(kid, items, children_of);
                if child.status != ComparisonStatus::Identical || child.difference_count > 0 {
                    item.difference_count += 1 + child.difference_count;
                    if item.status == ComparisonStatus::Identical {
                        item.status = ComparisonStatus::Modified;
                    }
                }
                built.push(child);
            }
            if let Some(children) = item.children.as_mut() {
                *children = built;
            }
        }
        item
    }

    let tree = roots.iter().map(|r| assemble(r, &mut items, &children_of)).collect();
    (tree, summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn finds_every_kind_of_difference() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        write(&src.path().join("same.txt"), "abc");
        write(&dst.path().join("same.txt"), "abc");
        write(&src.path().join("a/b/changed.txt"), "one");
        write(&dst.path().join("a/b/changed.txt"), "three");
        write(&src.path().join("gone.txt"), "x");
        write(&dst.path().join("new.txt"), "y");
        // Same content and the same mtime: identical.
        let when = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        for root in [src.path(), dst.path()] {
            fs::File::options().write(true).open(root.join("same.txt")).unwrap().set_modified(when).unwrap();
        }

        let (tree, summary) = compare(src.path(), dst.path(), false);
        assert_eq!(summary.identical, 1);
        assert_eq!(summary.modified, 1);
        assert_eq!(summary.missing_from_target, 1);
        assert_eq!(summary.extra_in_target, 1);

        // The change two levels down marks both ancestors.
        let a = tree.iter().find(|i| i.name == "a").unwrap();
        assert_eq!(a.status, ComparisonStatus::Modified);
        assert_eq!(a.difference_count, 2);
        let b = &a.children.as_ref().unwrap()[0];
        assert_eq!(b.status, ComparisonStatus::Modified);
        assert_eq!(b.difference_count, 1);
    }

    #[test]
    fn deep_scan_treats_same_content_as_identical() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        write(&src.path().join("f.bin"), "same bytes");
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&dst.path().join("f.bin"), "same bytes");

        let (_, summary) = compare(src.path(), dst.path(), true);
        assert_eq!(summary.identical, 1);
        assert_eq!(summary.modified, 0);
    }

    #[test]
    fn serializes_like_the_python_backend() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        write(&src.path().join("only.txt"), "x");
        let (tree, _) = compare(src.path(), dst.path(), false);
        let json = serde_json::to_value(&tree[0]).unwrap();
        assert_eq!(json["status"], "missing_from_target");
        assert_eq!(json["item_type"], "file");
        assert!(json["target_size"].is_null());
        assert!(json["children"].is_null());
    }
}
