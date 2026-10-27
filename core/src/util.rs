//! Small shared helpers: timestamps and per-file size rules.

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use std::fs::Metadata;
use std::time::{SystemTime, UNIX_EPOCH};

/// Python's `datetime.isoformat()` for a naive datetime: microseconds are
/// left out when they are zero.
fn python_iso(dt: NaiveDateTime) -> String {
    if dt.and_utc().timestamp_subsec_micros() == 0 {
        dt.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        dt.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

/// `datetime.now().isoformat()`: local time, no offset.
pub fn now_local_iso() -> String {
    python_iso(Local::now().naive_local())
}

/// `datetime.utcnow()`, as SQLAlchemy stores it ("YYYY-MM-DD HH:MM:SS.ffffff").
pub fn now_utc_db() -> String {
    Utc::now().naive_utc().format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// A stored `saved_at` value turned into the ISO form the API returns.
pub fn db_time_to_iso(stored: &str) -> String {
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(stored, fmt) {
            return python_iso(dt);
        }
    }
    stored.to_string()
}

/// `datetime.fromtimestamp(ts).isoformat()`: local time, no offset.
pub fn epoch_to_local_iso(ts: f64) -> String {
    let secs = ts.floor() as i64;
    let micros = ((ts - ts.floor()) * 1_000_000.0).round() as u32;
    let (secs, micros) = if micros >= 1_000_000 { (secs + 1, 0) } else { (secs, micros) };
    match Local.timestamp_opt(secs, micros * 1000).single() {
        Some(dt) => python_iso(dt.naive_local()),
        None => python_iso(DateTime::<Utc>::UNIX_EPOCH.naive_utc()),
    }
}

pub fn system_time_secs(t: std::io::Result<SystemTime>) -> f64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn now_secs() -> f64 {
    system_time_secs(Ok(SystemTime::now()))
}

pub fn mtime(md: &Metadata) -> f64 {
    system_time_secs(md.modified())
}

pub fn atime(md: &Metadata) -> f64 {
    system_time_secs(md.accessed())
}

/// Bytes a file actually occupies on this disk (like `du`).
///
/// Unix: allocated blocks. Windows has no block count, so this is the
/// apparent size, except that cloud-only placeholders (OneDrive, iCloud)
/// count as 0 because their data is not on the disk.
pub fn disk_usage_bytes(md: &Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        md.blocks() * 512
    }
    #[cfg(windows)]
    {
        if is_cloud_only(md) {
            0
        } else {
            md.len()
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        md.len()
    }
}

#[cfg(windows)]
fn is_cloud_only(md: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
    };
    md.file_attributes() & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) != 0
}

/// (device, inode) for files with more than one hard link, so they are only
/// counted once per scan. Windows does not expose these cheaply, so hard-link
/// dedupe is skipped there.
pub fn hardlink_key(md: &Metadata) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (md.nlink() > 1).then(|| (md.dev(), md.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = md;
        None
    }
}

/// Python's `os.path.splitext(name)[1].lower()`.
pub fn extension_of(name: &str) -> String {
    let stem_start = name.trim_start_matches('.');
    let leading = name.len() - stem_start.len();
    match stem_start.rfind('.') {
        Some(i) => name[leading + i..].to_lowercase(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitext_matches_python() {
        assert_eq!(extension_of("a.TXT"), ".txt");
        assert_eq!(extension_of("archive.tar.gz"), ".gz");
        assert_eq!(extension_of(".bashrc"), "");
        assert_eq!(extension_of("..hidden"), "");
        assert_eq!(extension_of("..hidden.md"), ".md");
        assert_eq!(extension_of("noext"), "");
        assert_eq!(extension_of("trailing."), ".");
    }

    #[test]
    fn db_times_round_trip() {
        assert_eq!(
            db_time_to_iso("2026-03-09 12:01:02.123456"),
            "2026-03-09T12:01:02.123456"
        );
        assert_eq!(db_time_to_iso("2026-03-09 12:01:02"), "2026-03-09T12:01:02");
    }
}
