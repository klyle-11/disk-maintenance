//! Offload stores and the drives they sit on.
//!
//! A store is a folder the user picked on an external drive. It is recognised
//! by the id in a small marker file inside it, never by its mount point: drive
//! letters and /Volumes names change, and two drives can share a label.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::catalog::{utc_now, StoreRecord};

pub const MARKER: &str = ".di-store.json";
pub const MANIFESTS: &str = ".di-catalog";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Marker {
    pub id: String,
    pub label: String,
    pub created_at: String,
    #[serde(default)]
    pub about: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Volume {
    pub mount: String,
    pub name: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

/// The store marker in `root`: Ok(None) when there is none, an error when
/// there is one that can't be read (it is then left alone, not replaced).
pub fn read_marker(root: &Path) -> Result<Option<Marker>, String> {
    let path = root.join(MARKER);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Couldn't read {}: {e}", path.display())),
    };
    let marker: Marker = serde_json::from_str(&text)
        .map_err(|e| format!("{} is damaged ({e}); it was left as it is", path.display()))?;
    if marker.id.is_empty()
        || marker.id.len() > 100
        || !marker
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(format!(
            "{} has an invalid id; it was left as it is",
            path.display()
        ));
    }
    Ok(Some(marker))
}

/// Write `bytes` to `path` so that a crash leaves either the old file or the
/// new one, never half of it.
pub fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let tmp = dir.join(format!(".di-tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        sync_dir(dir);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Flush a folder's own entries (new names, renames) to the disk.
pub fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// The marker of the store at `root`, written now if this is a new store.
pub fn ensure_marker(root: &Path) -> Result<Marker, String> {
    if let Some(marker) = read_marker(root)? {
        return Ok(marker);
    }
    let label = volume_name(root);
    let marker = Marker {
        id: uuid::Uuid::new_v4().to_string(),
        label,
        created_at: utc_now(),
        about: "Disk Intelligence offload store. Files here were moved off a computer; the .di-catalog folder lists them with their checksums. Do not delete this file.".into(),
    };
    let text = serde_json::to_string_pretty(&marker).expect("serializable");
    write_atomically(&root.join(MARKER), text.as_bytes())
        .map_err(|e| format!("Couldn't write to {}: {e}", root.display()))?;
    Ok(marker)
}

/// A name for the drive holding `path`: its mount folder's name when it sits
/// under a known mount, otherwise the folder's own name.
pub fn volume_name(path: &Path) -> String {
    let text = path.to_string_lossy();
    let best = volumes()
        .into_iter()
        .filter(|v| is_under(&text, &v.mount))
        .max_by_key(|v| v.mount.len());
    match best {
        Some(volume) if !volume.name.is_empty() => volume.name,
        _ => path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| text.into_owned()),
    }
}

fn is_under(path: &str, mount: &str) -> bool {
    let mount = mount.trim_end_matches(['/', '\\']);
    path == mount
        || path
            .strip_prefix(mount)
            .is_some_and(|rest| rest.starts_with(['/', '\\']))
}

fn volume(mount: PathBuf) -> Option<Volume> {
    let total = fs4::total_space(&mount).ok()?;
    if total == 0 {
        return None;
    }
    let name = mount
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            mount
                .to_string_lossy()
                .trim_end_matches(['/', '\\'])
                .to_string()
        });
    Some(Volume {
        name,
        total_bytes: total,
        free_bytes: fs4::available_space(&mount).unwrap_or(0),
        mount: mount.to_string_lossy().into_owned(),
    })
}

/// Drives other than the system disk that are connected right now.
#[cfg(target_os = "macos")]
pub fn volumes() -> Vec<Volume> {
    let Ok(entries) = fs::read_dir("/Volumes") else {
        return Vec::new();
    };
    let mut out: Vec<Volume> = entries
        .flatten()
        // The system volume appears in /Volumes as a link to "/".
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !e.file_name().to_string_lossy().starts_with("com.apple."))
        .filter_map(|e| volume(e.path()))
        .collect();
    out.sort_by(|a, b| a.mount.cmp(&b.mount));
    out
}

#[cfg(target_os = "windows")]
pub fn volumes() -> Vec<Volume> {
    let system = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".into())
        .to_uppercase();
    ('A'..='Z')
        .filter(|letter| format!("{letter}:") != system)
        .map(|letter| PathBuf::from(format!("{letter}:\\")))
        .filter(|root| root.is_dir())
        .filter_map(volume)
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn volumes() -> Vec<Volume> {
    let Ok(mounts) = fs::read_to_string("/proc/self/mounts") else {
        return Vec::new();
    };
    let mut out: Vec<Volume> = mounts
        .lines()
        .filter_map(linux_mount)
        .filter_map(volume)
        .collect();
    out.sort_by(|a, b| a.mount.cmp(&b.mount));
    out.dedup_by(|a, b| a.mount == b.mount);
    out
}

/// A line of /proc/mounts, if it is a place a person would keep files on a
/// removable or network drive.
#[cfg(all(unix, not(target_os = "macos")))]
fn linux_mount(line: &str) -> Option<PathBuf> {
    let mut fields = line.split(' ');
    let (_device, mount, fstype) = (fields.next()?, fields.next()?, fields.next()?);
    // Spaces and the like are written as octal escapes.
    let mount = mount
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\134", "\\");
    const REMOVABLE: &[&str] = &["/media/", "/run/media/", "/mnt/"];
    const DISK_TYPES: &[&str] = &[
        "vfat",
        "exfat",
        "msdos",
        "ntfs",
        "ntfs3",
        "fuseblk",
        "ext2",
        "ext3",
        "ext4",
        "btrfs",
        "xfs",
        "f2fs",
        "hfsplus",
        "apfs",
        "nfs",
        "nfs4",
        "cifs",
        "smb3",
        "fuse.sshfs",
        "zfs",
    ];
    if !REMOVABLE.iter().any(|prefix| mount.starts_with(prefix)) || !DISK_TYPES.contains(&fstype) {
        return None;
    }
    Some(PathBuf::from(mount))
}

/// Where a known store is right now, if its drive is connected. Looks where
/// it was last seen, then for the same folder on every connected drive (the
/// mount point may have changed).
pub fn locate(store: &StoreRecord) -> Option<PathBuf> {
    let holds =
        |root: &Path| matches!(read_marker(root), Ok(Some(marker)) if marker.id == store.id);
    let last = PathBuf::from(&store.last_path);
    if holds(&last) {
        return Some(last);
    }
    let parts: Vec<_> = last
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(name) => Some(name.to_os_string()),
            _ => None,
        })
        .collect();
    for volume in volumes() {
        // The store's folder under this drive: try each tail of the old path,
        // longest first, ending with the drive's own top folder.
        for skip in 0..=parts.len() {
            let mut candidate = PathBuf::from(&volume.mount);
            candidate.extend(&parts[skip..]);
            if holds(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_marker_is_made_once_and_then_kept() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_marker(tmp.path()).unwrap(), None);
        let first = ensure_marker(tmp.path()).unwrap();
        assert_eq!(ensure_marker(tmp.path()).unwrap(), first);
        let leftovers: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(
            leftovers,
            [std::ffi::OsString::from(MARKER)],
            "no temporary file is left behind"
        );
    }

    #[test]
    fn a_damaged_marker_is_reported_not_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join(MARKER), "{ not json").unwrap();
        assert!(ensure_marker(tmp.path()).unwrap_err().contains("damaged"));
        assert_eq!(
            fs::read_to_string(tmp.path().join(MARKER)).unwrap(),
            "{ not json"
        );
        fs::write(
            tmp.path().join(MARKER),
            r#"{"id":"../../etc","label":"x","created_at":"t"}"#,
        )
        .unwrap();
        assert!(read_marker(tmp.path()).unwrap_err().contains("invalid id"));
    }

    #[test]
    fn a_store_is_found_by_its_id_where_it_was_last_seen() {
        let tmp = tempfile::tempdir().unwrap();
        let marker = ensure_marker(tmp.path()).unwrap();
        let mut store = StoreRecord {
            id: marker.id.clone(),
            label: marker.label,
            last_path: tmp.path().to_string_lossy().into_owned(),
            created_at: marker.created_at,
            last_seen_at: utc_now(),
        };
        assert_eq!(locate(&store), Some(tmp.path().to_path_buf()));
        // Another drive mounted at the same place is not this store.
        store.id = "someone-else".into();
        assert_eq!(locate(&store), None);
    }

    #[test]
    fn under_means_a_whole_path_prefix() {
        assert!(is_under("/media/me/DISK/x", "/media/me/DISK"));
        assert!(is_under("/media/me/DISK", "/media/me/DISK/"));
        assert!(!is_under("/media/me/DISK2/x", "/media/me/DISK"));
    }
}
