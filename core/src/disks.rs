//! The disks the hub shows free space for: the one holding the home folder
//! first, then other drives (internal and external), without the system's
//! own pseudo and read-only volumes.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DiskInfo {
    /// Short label: "C:", "Macintosh HD", "/", "USB".
    pub name: String,
    pub mount: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub removable: bool,
    /// Holds the home folder.
    pub home: bool,
}

/// Linux file systems that are not disks you'd fill up.
const PSEUDO_FS: &[&str] = &[
    "tmpfs",
    "devtmpfs",
    "ramfs",
    "squashfs",
    "overlay",
    "efivarfs",
    "proc",
    "sysfs",
    "cgroup",
    "cgroup2",
    "autofs",
    "debugfs",
    "tracefs",
    "securityfs",
    "pstore",
    "bpf",
    "fusectl",
    "configfs",
    "mqueue",
    "hugetlbfs",
    "devpts",
    "nsfs",
    "binfmt_misc",
];

/// Mounts that belong to the OS itself rather than to the user.
fn system_mount(mount: &str) -> bool {
    if cfg!(target_os = "macos") {
        // APFS shows each system volume separately; "/" and /Volumes/* are
        // the ones a person thinks of as disks.
        return mount != "/" && !mount.starts_with("/Volumes/");
    }
    if cfg!(target_os = "linux") {
        let under = |p: &str| mount == p || mount.starts_with(&format!("{p}/"));
        return [
            "/boot",
            "/snap",
            "/proc",
            "/sys",
            "/dev",
            "/var/lib/docker",
            "/var/snap",
        ]
        .iter()
        .any(|p| under(p))
            || (under("/run") && !mount.starts_with("/run/media/"));
    }
    false
}

fn label(name: &str, mount: &Path) -> String {
    let mount_str = mount.to_string_lossy();
    if cfg!(windows) {
        return mount_str.trim_end_matches('\\').to_string();
    }
    if cfg!(target_os = "macos") && !name.is_empty() {
        return name.to_string();
    }
    if mount_str == "/" {
        return "/".into();
    }
    mount
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| mount_str.into_owned())
}

/// The mount that holds `path`: the longest mount point it sits under.
fn holder<'a>(path: &Path, mounts: impl Iterator<Item = &'a Path>) -> Option<PathBuf> {
    mounts
        .filter(|m| path.starts_with(m))
        .max_by_key(|m| m.as_os_str().len())
        .map(Path::to_path_buf)
}

pub fn list_disks() -> Vec<DiskInfo> {
    let Ok(disks) = sysinfo::Disks::new_with_refreshed_list() else {
        return Vec::new();
    };
    let home_mount =
        dirs::home_dir().and_then(|h| holder(&h, disks.iter().map(|d| d.mount_point())));

    let mut seen_devices = HashSet::new();
    let mut out: Vec<DiskInfo> = Vec::new();
    // Shortest mounts first, so a device mounted twice keeps its main mount.
    let mut list: Vec<_> = disks.iter().collect();
    list.sort_by_key(|d| d.mount_point().as_os_str().len());
    for d in list {
        let mount = d.mount_point();
        let mount_str = mount.to_string_lossy().into_owned();
        let is_home = home_mount.as_deref() == Some(mount);
        let fs = d.file_system().to_string_lossy().to_lowercase();
        let name = d.name().to_string_lossy().into_owned();
        let skip = d.total_space() == 0
            || (!is_home
                && (system_mount(&mount_str)
                    || PSEUDO_FS.contains(&fs.as_str())
                    || (d.is_read_only() && mount_str != "/")));
        if skip {
            continue;
        }
        // Linux shows a btrfs subvolume or bind mount once per mount point.
        if cfg!(target_os = "linux")
            && name.starts_with("/dev/")
            && !seen_devices.insert(name.clone())
        {
            continue;
        }
        out.push(DiskInfo {
            name: label(&name, mount),
            mount: mount_str,
            total_bytes: d.total_space(),
            free_bytes: d.available_space(),
            removable: d.is_removable(),
            home: is_home,
        });
    }
    out.sort_by(|a, b| b.home.cmp(&a.home).then(a.mount.cmp(&b.mount)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_home_disk_first() {
        let disks = list_disks();
        assert!(!disks.is_empty(), "no disks found");
        assert!(disks[0].home, "{disks:?}");
        assert!(disks[0].total_bytes >= disks[0].free_bytes);
        assert_eq!(disks.iter().filter(|d| d.home).count(), 1);
    }

    #[test]
    fn finds_the_mount_that_holds_a_path() {
        let mounts = [Path::new("/"), Path::new("/home"), Path::new("/home2")];
        assert_eq!(
            holder(Path::new("/home/me"), mounts.into_iter()),
            Some(PathBuf::from("/home"))
        );
        assert_eq!(
            holder(Path::new("/etc"), mounts.into_iter()),
            Some(PathBuf::from("/"))
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn skips_system_mounts() {
        assert!(system_mount("/boot/efi"));
        assert!(system_mount("/run/user/1000"));
        assert!(!system_mount("/run/media/me/USB"));
        assert!(!system_mount("/media/me/USB"));
        assert!(!system_mount("/"));
    }
}
