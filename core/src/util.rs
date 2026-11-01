//! Small shared pieces: which folders scans skip, timestamps, free space, and
//! where the app keeps its data.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Absolute paths skipped along with everything beneath them, matched as whole
/// path prefixes, so "/Library" skips /Library but not ~/Library.
#[cfg(target_os = "windows")]
const IGNORE_PREFIXES: &[&str] = &["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"];
#[cfg(target_os = "macos")]
const IGNORE_PREFIXES: &[&str] = &["/System", "/Applications", "/Library", "/Users/Shared", "/private"];
#[cfg(all(unix, not(target_os = "macos")))]
const IGNORE_PREFIXES: &[&str] = &["/usr", "/bin", "/sbin", "/lib", "/lib64", "/var", "/etc"];

/// Folder names skipped wherever they appear, matched against the exact name.
#[cfg(target_os = "macos")]
const IGNORE_NAMES: &[&str] = &[
    ".Trashes",
    ".fseventsd",
    ".Spotlight-V100",
    ".DocumentRevisions-V100",
    "$Recycle.Bin",
    "System Volume Information",
    "RECYCLER",
];
#[cfg(not(target_os = "macos"))]
const IGNORE_NAMES: &[&str] = &["$Recycle.Bin", "System Volume Information", "RECYCLER"];

/// macOS and Windows file systems are case-insensitive by default.
const CASE_INSENSITIVE_FS: bool = cfg!(any(target_os = "macos", target_os = "windows"));

fn fold(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if CASE_INSENSITIVE_FS {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// True if `path` is an ignored system location or an ignored folder name.
pub fn should_ignore(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if IGNORE_NAMES.iter().any(|n| n.to_lowercase() == name) {
        return true;
    }
    let folded = fold(&path.to_string_lossy());
    IGNORE_PREFIXES.iter().any(|prefix| {
        let prefix = fold(prefix);
        folded == prefix || folded.starts_with(&format!("{prefix}/"))
    })
}

/// Seconds since the epoch, as a float (0.0 when unknown).
pub fn epoch_secs(time: std::io::Result<SystemTime>) -> f64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn now_secs() -> f64 {
    epoch_secs(Ok(SystemTime::now()))
}

/// Local time like Python's `datetime.now().isoformat()`.
pub fn local_iso_now() -> String {
    chrono::Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
}

/// A file time as Python's `datetime.fromtimestamp(t).isoformat()` writes it.
pub fn local_iso(secs: f64) -> String {
    let whole = secs.floor();
    let nanos = ((secs - whole) * 1e9).round() as u32;
    match chrono::DateTime::from_timestamp(whole as i64, nanos.min(999_999_999)) {
        Some(utc) => {
            let local = utc.with_timezone(&chrono::Local).naive_local();
            if local.and_utc().timestamp_subsec_micros() == 0 {
                local.format("%Y-%m-%dT%H:%M:%S").to_string()
            } else {
                local.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
            }
        }
        None => String::new(),
    }
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Free bytes on the disk holding the home folder (what `di` reports).
pub fn free_bytes() -> u64 {
    fs2::available_space(home_dir()).unwrap_or(0)
}

/// The database the app and `di` share. DISK_INTELLIGENCE_DB overrides it.
pub fn default_db_path() -> PathBuf {
    if let Ok(path) = std::env::var("DISK_INTELLIGENCE_DB") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(home_dir)
    } else if cfg!(target_os = "macos") {
        home_dir().join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".local").join("share"))
    };
    base.join("DiskIntelligence").join("disk_intelligence.db")
}

/// Checks a folder the user asked to scan or compare, and returns it absolute.
/// Drop `.` and resolve `..` in the path's text, so scans store clean paths.
fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

pub fn existing_dir(path: &str, what: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{what} is empty"));
    }
    if trimmed.contains('\0') {
        return Err(format!("{what} contains a NUL character"));
    }
    if trimmed.len() > 4096 {
        return Err(format!("{what} is too long"));
    }
    let expanded = if trimmed == "~" {
        home_dir()
    } else if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        home_dir().join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    let absolute = if expanded.is_absolute() { expanded } else { std::env::current_dir().map_err(|e| e.to_string())?.join(expanded) };
    let absolute = normalize(&absolute);
    if !absolute.exists() {
        return Err(format!("{what} does not exist: {}", absolute.display()));
    }
    if !absolute.is_dir() {
        return Err(format!("{what} is not a directory: {}", absolute.display()));
    }
    Ok(absolute)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_system_names_and_prefixes_only_exactly() {
        assert!(should_ignore(Path::new("/x/$Recycle.Bin")));
        assert!(!should_ignore(Path::new("/x/Recycle.Bin.notes")));
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            assert!(should_ignore(Path::new("/usr/share")));
            assert!(!should_ignore(Path::new("/usrlocal")));
            assert!(!should_ignore(Path::new("/home/me/usr")));
        }
    }

    #[test]
    fn folder_paths_are_checked_and_cleaned() {
        let tmp = std::env::temp_dir();
        let messy = format!("{}/./x/..", tmp.display());
        assert_eq!(existing_dir(&messy, "Folder").unwrap(), normalize(&tmp));
        assert!(existing_dir("  ", "Folder").unwrap_err().contains("empty"));
        assert!(existing_dir("/no/such/place", "Folder").unwrap_err().contains("does not exist"));
        assert!(existing_dir(&"a".repeat(5000), "Folder").unwrap_err().contains("too long"));
    }

    #[test]
    fn iso_drops_zero_microseconds_like_python() {
        assert!(!local_iso(1_700_000_000.0).contains('.'));
        assert!(local_iso(1_700_000_000.25).ends_with(".250000"));
    }
}
