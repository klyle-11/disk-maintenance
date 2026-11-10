//! Offloading: moving a folder to an external drive without ever being the
//! reason a file is lost.
//!
//! The rules the code below keeps, and the tests in `tests/` hold it to:
//!
//! 1. **An original is removed only after its copy was read back.** A file is
//!    written under a temporary name, flushed to the drive, read back from the
//!    drive and compared by SHA-256 with what was read from the original. Only
//!    then does it get its real name and a row in the catalog.
//! 2. **Removal checks again.** Just before an original is removed, its copy
//!    is read from the drive once more and compared with the recorded
//!    checksum, and the original must still be the file that was copied. If
//!    either is not so, the original stays and the report says why.
//! 3. **Nothing on the drive is overwritten.** A different file already at the
//!    destination is a conflict, reported and left alone.
//! 4. **Nothing is skipped silently.** Every entry found is counted as
//!    verified, failed or skipped; an unreadable folder is a failure, not an
//!    empty folder.
//! 5. **Stopping anywhere is safe.** A cancel, an unplugged drive, a full
//!    drive or a power cut leaves every original in place unless its copy was
//!    already verified and recorded. Running the same offload again resumes.
//! 6. **The drive describes itself.** A manifest of what is on it, with
//!    checksums, is written to the drive before any original is removed, so
//!    the catalog can be rebuilt if this computer's database is lost.
//!
//! What is not preserved: extended attributes, ACLs, macOS resource forks,
//! ownership, hard-link relationships (each link becomes its own copy) and
//! sparseness. Permissions and modification times are kept where the drive's
//! file system has them.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::catalog::{utc_now, Catalog, FileRow, JobRecord};
use crate::drives::{self, sync_dir, write_atomically, MANIFESTS};
use crate::paths::IgnoreRules;
use crate::scanner::ScanData;
use crate::snapshots::default_db_path;
use crate::util::now_secs;

/// Names of files still being copied. They are never treated as content.
pub const TMP_PREFIX: &str = ".di-part-";
const BUF: usize = 1024 * 1024;
const MAX_PROBLEMS: usize = 500;
const DAMAGED: &str =
    "the copy on the drive is damaged: its contents no longer match what was recorded";

// ---------------------------------------------------------------------------
// Options, progress, hooks
// ---------------------------------------------------------------------------

/// What happens to the originals once their copies are verified.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoveMode {
    /// Leave them; they can be released later.
    Keep,
    /// Move the whole folder to the Trash, and only if all of it was copied.
    Trash,
    /// Delete each original whose copy is verified.
    Delete,
}

#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub remove: RemoveMode,
    /// Allow a store on the same disk as the source (which frees nothing).
    pub allow_same_volume: bool,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            remove: RemoveMode::Keep,
            allow_same_volume: false,
        }
    }
}

pub const PHASE_COUNTING: u8 = 1;
pub const PHASE_COPYING: u8 = 2;
pub const PHASE_REMOVING: u8 = 3;
pub const PHASE_CHECKING: u8 = 4;
pub const PHASE_RESTORING: u8 = 5;

/// Live counters a caller can read while a run is under way.
#[derive(Default)]
pub struct Progress {
    pub phase: AtomicU8,
    pub files_total: AtomicU64,
    pub bytes_total: AtomicU64,
    pub files_done: AtomicU64,
    pub bytes_done: AtomicU64,
    pub problems: AtomicU64,
    pub current: Mutex<String>,
}

impl Progress {
    fn set_current(&self, path: &str) {
        if let Ok(mut current) = self.current.try_lock() {
            current.clear();
            current.push_str(path);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub phase: &'static str,
    pub files_total: u64,
    pub bytes_total: u64,
    pub files_done: u64,
    pub bytes_done: u64,
    pub problems: u64,
    pub current_path: String,
}

pub fn progress_event(progress: &Progress) -> ProgressEvent {
    ProgressEvent {
        phase: match progress.phase.load(Ordering::Relaxed) {
            PHASE_COUNTING => "counting",
            PHASE_COPYING => "copying",
            PHASE_REMOVING => "removing",
            PHASE_CHECKING => "checking",
            PHASE_RESTORING => "restoring",
            _ => "starting",
        },
        files_total: progress.files_total.load(Ordering::Relaxed),
        bytes_total: progress.bytes_total.load(Ordering::Relaxed),
        files_done: progress.files_done.load(Ordering::Relaxed),
        bytes_done: progress.bytes_done.load(Ordering::Relaxed),
        problems: progress.problems.load(Ordering::Relaxed),
        current_path: progress
            .current
            .lock()
            .map(|c| c.clone())
            .unwrap_or_default(),
    }
}

/// Where in a run a [`Hook`] is called.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Point {
    /// About to handle a file or link.
    FileStart,
    /// A chunk was written to the temporary file.
    Chunk,
    /// The temporary file is complete and flushed.
    Written,
    /// About to read the temporary file back.
    ReadBack,
    /// About to give the copy its real name.
    Rename,
    /// The copy has its real name.
    Renamed,
    /// The entry is in the catalog (not yet committed).
    Recorded,
    /// Every entry is committed; about to write the drive's manifest.
    Manifest,
    /// About to check and remove one original.
    BeforeRemove,
    /// An original was removed.
    Removed,
    /// About to remove an emptied folder.
    RemoveDir,
}

/// Lets tests break a run at an exact point: return an error to make that
/// step fail, or [`crash`] to stop the run dead as a power cut would.
pub trait Hook: Sync {
    fn at(&self, _point: Point, _path: &Path) -> io::Result<()> {
        Ok(())
    }
    /// Stand in for the system Trash (None: use the real one).
    fn trash(&self, _path: &Path) -> Option<io::Result<()>> {
        None
    }
    /// Pretend the drive does (or doesn't) tell upper and lower case apart
    /// (None: find out).
    fn folds_case(&self) -> Option<bool> {
        None
    }
}

pub struct NoHook;
impl Hook for NoHook {}

#[derive(Debug)]
struct CrashMarker;
impl std::fmt::Display for CrashMarker {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("simulated crash")
    }
}
impl std::error::Error for CrashMarker {}

/// The error a [`Hook`] returns to end a run on the spot, with no cleanup.
pub fn crash() -> io::Error {
    io::Error::other(CrashMarker)
}

/// What `offload` and friends return when a hook simulated a crash.
pub const CRASHED: &str = "simulated crash";

pub struct Control<'a> {
    pub progress: &'a Progress,
    pub cancel: &'a AtomicBool,
    pub hook: &'a dyn Hook,
}

/// Why a step did not finish.
#[derive(Debug)]
enum Fail {
    /// This entry failed; the run goes on.
    Io(String),
    /// The drive is full: this entry failed and the run stops.
    Full(String),
    /// The run stops, for this reason.
    Abort(String),
    Cancelled,
    Crash,
}

type Step<T> = Result<T, Fail>;

fn fail(what: &str, e: io::Error) -> Fail {
    let message = format!("{what}: {e}");
    if is_full(&e) {
        Fail::Full(message)
    } else {
        Fail::Io(message)
    }
}

/// Whether an error means the drive (or the user's quota on it) is full.
/// By the system's own code rather than `ErrorKind::StorageFull`, which needs
/// a newer Rust than this crate asks for.
fn is_full(e: &io::Error) -> bool {
    #[cfg(unix)]
    return matches!(e.raw_os_error(), Some(code) if code == libc::ENOSPC || code == libc::EDQUOT);
    // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL, ERROR_DISK_QUOTA_EXCEEDED
    #[cfg(windows)]
    return matches!(e.raw_os_error(), Some(39 | 112 | 1295));
    #[cfg(not(any(unix, windows)))]
    return false;
}

/// The error a full drive gives, for tests that stand in for one.
pub fn disk_full() -> io::Error {
    #[cfg(unix)]
    return io::Error::from_raw_os_error(libc::ENOSPC);
    #[cfg(not(unix))]
    return io::Error::from_raw_os_error(112);
}

fn db(e: rusqlite::Error) -> Fail {
    Fail::Abort(format!("the catalog couldn't be written: {e}"))
}

impl Control<'_> {
    fn hook(&self, point: Point, path: &Path) -> Step<()> {
        match self.hook.at(point, path) {
            Ok(()) => Ok(()),
            Err(e) if e.get_ref().is_some_and(|inner| inner.is::<CrashMarker>()) => {
                Err(Fail::Crash)
            }
            Err(e) => Err(fail("failed", e)),
        }
    }

    fn cancelled(&self) -> Step<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(Fail::Cancelled)
        } else {
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Problem {
    pub path: String,
    /// "failed", "skipped", "kept" (an original that was not removed),
    /// "missing" or "damaged" (on the drive)
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Default)]
struct Problems {
    list: Vec<Problem>,
    total: u64,
}

impl Problems {
    fn add(&mut self, path: &str, kind: &str, message: impl Into<String>) {
        self.total += 1;
        if self.list.len() < MAX_PROBLEMS {
            self.list.push(Problem {
                path: path.into(),
                kind: kind.into(),
                message: message.into(),
            });
        }
    }
}

/// What the removal of originals did.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Removal {
    /// Copied files and links whose originals were looked at.
    pub checked: u64,
    pub removed_files: u64,
    pub removed_bytes: u64,
    /// Disk space the removals gave back (0 for the Trash, until emptied).
    pub freed_bytes: u64,
    /// Originals left in place because a check did not pass.
    pub kept_files: u64,
    /// Originals that were already gone.
    pub already_gone: u64,
    pub folders_removed: u64,
    pub folders_left: u64,
    pub trashed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub job_id: String,
    pub store_id: String,
    pub store_label: String,
    pub source: String,
    pub dest: String,
    /// "complete": everything found is on the drive, verified, and every
    /// original that was to be removed is gone. "incomplete": something is
    /// not (see `problems`). "cancelled": stopped by the user.
    pub outcome: String,
    /// Why the run stopped early, if it did.
    pub stopped: Option<String>,
    /// Files, links and unreadable folders found. Always
    /// `verified_files + failed + skipped`.
    pub items_seen: u64,
    pub bytes_seen: u64,
    /// Written to the drive by this run.
    pub copied_files: u64,
    pub copied_bytes: u64,
    /// Already on the drive with the same contents (read and compared).
    pub already_files: u64,
    pub already_bytes: u64,
    /// `copied_files + already_files`.
    pub verified_files: u64,
    pub verified_bytes: u64,
    pub failed: u64,
    pub skipped: u64,
    pub removal: Removal,
    pub problems: Vec<Problem>,
    pub problems_total: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ReleaseReport {
    pub job_id: String,
    pub outcome: String,
    pub stopped: Option<String>,
    pub removal: Removal,
    pub problems: Vec<Problem>,
    pub problems_total: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CheckReport {
    pub job_id: String,
    /// "ok", "problems" or "cancelled"
    pub outcome: String,
    pub checked: u64,
    pub ok: u64,
    pub missing: u64,
    pub damaged: u64,
    pub bytes_read: u64,
    pub problems: Vec<Problem>,
    pub problems_total: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RestoreReport {
    pub job_id: String,
    pub target: String,
    /// "complete", "incomplete" or "cancelled"
    pub outcome: String,
    pub stopped: Option<String>,
    pub restored_files: u64,
    pub restored_bytes: u64,
    /// Already at the target with the same contents.
    pub already_files: u64,
    pub failed: u64,
    pub problems: Vec<Problem>,
    pub problems_total: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportReport {
    pub store_id: String,
    pub store_label: String,
    pub jobs_added: u64,
    pub jobs_known: u64,
    pub files_added: u64,
    pub rows_rejected: u64,
}

// ---------------------------------------------------------------------------
// Small pieces: paths, stamps, hashing
// ---------------------------------------------------------------------------

/// `base` plus a catalog path. None if the path is not a plain relative path:
/// a manifest read from a drive must not be able to point outside the folder
/// it is restored into.
pub fn join_rel(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    if rel.is_empty() {
        return Some(out);
    }
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains('\0') {
            return None;
        }
        if cfg!(windows) && (part.contains('\\') || part.contains(':')) {
            return None;
        }
        // On Unix this also rejects nothing else: "\" is an ordinary character.
        if Path::new(part).components().count() != 1
            || !matches!(
                Path::new(part).components().next(),
                Some(Component::Normal(_))
            )
        {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

/// This computer's name, as a folder name.
pub fn host_name() -> String {
    #[cfg(unix)]
    let raw = {
        let mut buf = vec![0u8; 256];
        // SAFETY: the buffer is valid for its length; the result is NUL-terminated or truncated.
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        if ok {
            String::from_utf8_lossy(&buf[..end]).into_owned()
        } else {
            String::new()
        }
    };
    #[cfg(not(unix))]
    let raw = std::env::var("COMPUTERNAME").unwrap_or_default();
    let clean: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean = clean.trim_matches('.').to_string();
    if clean.is_empty() {
        "computer".into()
    } else {
        clean
    }
}

/// Where a source's copy goes under the store: the computer's name, then the
/// source's own absolute path. Two sources can never land on the same place.
pub fn rel_base_for(host: &str, source: &Path) -> Result<String, String> {
    let mut parts = vec![host.to_string()];
    for component in source.components() {
        match component {
            Component::Prefix(prefix) => {
                let text = prefix.as_os_str().to_string_lossy();
                let clean: String = text
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                    .collect();
                parts.push(if clean.is_empty() {
                    "drive".into()
                } else {
                    clean
                });
            }
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("Not a plain absolute path: {}", source.display()))
            }
            Component::Normal(name) => match name.to_str() {
                Some(name) => parts.push(name.to_string()),
                None => {
                    return Err(format!(
                        "The folder's path is not valid Unicode: {}",
                        source.display()
                    ))
                }
            },
        }
    }
    Ok(parts.join("/"))
}

#[cfg(unix)]
fn mtime_ns(meta: &fs::Metadata) -> i64 {
    use std::os::unix::fs::MetadataExt;
    meta.mtime()
        .saturating_mul(1_000_000_000)
        .saturating_add(meta.mtime_nsec())
}

#[cfg(not(unix))]
fn mtime_ns(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

/// Everything about a file that changes when its contents do. On Unix this
/// includes the inode's change time, which a program cannot set back, so an
/// equal stamp means an untouched file.
#[cfg(unix)]
fn stamp(meta: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!(
        "u:{}:{}:{}:{}:{}.{}",
        meta.dev(),
        meta.ino(),
        meta.len(),
        mtime_ns(meta),
        meta.ctime(),
        meta.ctime_nsec()
    )
}

#[cfg(not(unix))]
fn stamp(meta: &fs::Metadata) -> String {
    format!("w:{}:{}", meta.len(), mtime_ns(meta))
}

/// An equal stamp proves an unchanged file (Unix). Elsewhere the contents are
/// read again instead.
const STRONG_STAMPS: bool = cfg!(unix);

/// How long a file must have been left alone before its stamp is trusted.
/// File systems record times in coarse steps, so two writes a moment apart
/// can leave the same stamp; a file touched this recently gets no stamp, and
/// is compared by contents before its original is removed.
#[cfg(unix)]
const SETTLE_SECS: i64 = 3;

/// The stamp to record for a file just copied, if it can be trusted later.
#[cfg(unix)]
fn settled_stamp(meta: &fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(i64::MAX);
    let last = meta.mtime().max(meta.ctime());
    // A time in the future is no proof of anything either.
    (last <= now && now - last >= SETTLE_SECS).then(|| stamp(meta))
}

#[cfg(not(unix))]
fn settled_stamp(_meta: &fs::Metadata) -> Option<String> {
    None
}

#[cfg(unix)]
fn mode_of(meta: &fs::Metadata) -> Option<i64> {
    use std::os::unix::fs::MetadataExt;
    Some((meta.mode() & 0o7777) as i64)
}

#[cfg(not(unix))]
fn mode_of(_meta: &fs::Metadata) -> Option<i64> {
    None
}

/// Disk space removing this file gives back.
#[cfg(unix)]
fn freed_by(meta: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    // Another hard link keeps the data alive.
    if meta.nlink() > 1 {
        0
    } else {
        meta.blocks() * 512
    }
}

#[cfg(not(unix))]
fn freed_by(meta: &fs::Metadata) -> u64 {
    meta.len()
}

/// Ask the system not to answer the read that follows from memory, so a copy
/// is checked against what the drive actually holds. Best effort: where the
/// system offers no way, a later CHECK (after the drive was reconnected) is
/// the stronger test.
fn avoid_cache(file: &fs::File) {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: a valid open descriptor; the call only advises the kernel.
        unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: a valid open descriptor; F_NOCACHE only changes caching.
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_NOCACHE, 1) };
    }
    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    let _ = file;
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// A file's SHA-256 and length, read from the disk.
fn hash_file(ctl: &Control, path: &Path, from_device: bool) -> Step<(String, u64)> {
    let mut file = fs::File::open(path).map_err(|e| fail("couldn't open", e))?;
    if from_device {
        avoid_cache(&file);
    }
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; BUF];
    let mut total = 0u64;
    loop {
        ctl.cancelled()?;
        let n = match file.read(&mut buf) {
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(fail("couldn't read", e)),
        };
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hex(&hasher.finalize()), total))
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// A folder that is really there, not a link to one.
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// Flush `dir` and each folder above it, up to and including `top`, so the
/// names of folders just created are on the drive.
fn sync_up_to(dir: &Path, top: &Path) {
    for folder in dir.ancestors() {
        sync_dir(folder);
        if folder == top || !folder.starts_with(top) {
            break;
        }
    }
}

/// Remove leftovers of interrupted copies from a folder this run writes to.
fn clear_stale_parts(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(TMP_PREFIX)
            && entry.file_type().map(|t| t.is_file()).unwrap_or(false)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------
// The verified copy (used for offloading and for restoring)
// ---------------------------------------------------------------------------

struct Copied {
    sha256: String,
    size: u64,
    stamp: Option<String>,
    mtime_ns: i64,
    mode: Option<i64>,
}

/// Copy `src` to `dst` (which must not exist), and return only once the copy
/// has been read back from the destination and matches. With `expect`, the
/// source itself must hash to that value (restoring from a drive).
fn copy_verified(ctl: &Control, src: &Path, dst: &Path, expect: Option<&str>) -> Step<Copied> {
    let meta = fs::symlink_metadata(src).map_err(|e| fail("couldn't read", e))?;
    if !meta.is_file() {
        return Err(Fail::Io("is not a regular file any more".into()));
    }
    let parent = dst
        .parent()
        .ok_or_else(|| Fail::Io("has no parent folder".into()))?;
    let tmp = parent.join(format!(
        "{TMP_PREFIX}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..16]
    ));
    match copy_through(ctl, src, &meta, &tmp, dst, expect) {
        // A crash cleans nothing up; the next run does.
        Err(Fail::Crash) => Err(Fail::Crash),
        Err(other) => {
            let _ = fs::remove_file(&tmp);
            Err(other)
        }
        Ok(copied) => Ok(copied),
    }
}

fn copy_through(
    ctl: &Control,
    src: &Path,
    meta: &fs::Metadata,
    tmp: &Path,
    dst: &Path,
    expect: Option<&str>,
) -> Step<Copied> {
    let mut input = fs::File::open(src).map_err(|e| fail("couldn't open", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // The file opened must be the file that was looked at.
        let opened = input.metadata().map_err(|e| fail("couldn't read", e))?;
        if (opened.dev(), opened.ino()) != (meta.dev(), meta.ino()) {
            return Err(Fail::Io("was replaced while it was being copied".into()));
        }
    }
    if expect.is_some() {
        avoid_cache(&input);
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp)
        .map_err(|e| fail("couldn't create the copy", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; BUF];
    let mut total = 0u64;
    loop {
        ctl.cancelled()?;
        let n = match input.read(&mut buf) {
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(fail("couldn't read", e)),
        };
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        output
            .write_all(&buf[..n])
            .map_err(|e| fail("couldn't write the copy", e))?;
        total += n as u64;
        ctl.progress
            .bytes_done
            .fetch_add(n as u64, Ordering::Relaxed);
        ctl.hook(Point::Chunk, tmp)?;
    }
    let sha256 = hex(&hasher.finalize());
    output
        .flush()
        .map_err(|e| fail("couldn't write the copy", e))?;
    output
        .sync_all()
        .map_err(|e| fail("couldn't flush the copy to the drive", e))?;
    avoid_cache(&output);
    drop(output);
    drop(input);
    ctl.hook(Point::Written, tmp)?;

    // The original must not have changed under the read.
    let after = fs::symlink_metadata(src).map_err(|e| fail("couldn't read", e))?;
    if total != meta.len() || stamp(&after) != stamp(meta) {
        return Err(Fail::Io(
            "changed while it was being copied; it was left where it is".into(),
        ));
    }
    if expect.is_some_and(|expected| expected != sha256) {
        return Err(Fail::Io(DAMAGED.into()));
    }

    // Read the copy back from the destination.
    ctl.hook(Point::ReadBack, tmp)?;
    let (read_back, read_len) = hash_file(ctl, tmp, true)?;
    if read_len != total || read_back != sha256 {
        return Err(Fail::Io("the copy did not read back the same as the original; it was discarded and the original left where it is".into()));
    }

    // Keep the original's time and permissions where the drive can (both are
    // extras: failing to set them does not make the copy wrong).
    if let Ok(modified) = meta.modified() {
        let _ = fs::OpenOptions::new()
            .write(true)
            .open(tmp)
            .and_then(|f| f.set_modified(modified));
    }
    #[cfg(unix)]
    let _ = fs::set_permissions(tmp, meta.permissions());

    ctl.hook(Point::Rename, dst)?;
    if fs::symlink_metadata(dst).is_ok() {
        return Err(Fail::Io("something with this name appeared at the destination during the copy; it was not overwritten".into()));
    }
    fs::rename(tmp, dst).map_err(|e| fail("couldn't name the copy", e))?;
    ctl.hook(Point::Renamed, dst)?;
    Ok(Copied {
        sha256,
        size: total,
        stamp: settled_stamp(&after),
        mtime_ns: mtime_ns(meta),
        mode: mode_of(meta),
    })
}

#[cfg(unix)]
fn make_link(target: &str, at: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, at)
}

#[cfg(windows)]
fn make_link(target: &str, at: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(target, at)
}

#[cfg(not(any(unix, windows)))]
fn make_link(_target: &str, _at: &Path) -> io::Result<()> {
    Err(io::Error::other("links are not supported here"))
}

fn link_target(path: &Path) -> Step<String> {
    let target = fs::read_link(path).map_err(|e| fail("couldn't read the link", e))?;
    target.to_str().map(str::to_string).ok_or_else(|| {
        Fail::Io("the link's target is not valid Unicode; it was left where it is".into())
    })
}

// ---------------------------------------------------------------------------
// Checks before a run
// ---------------------------------------------------------------------------

/// A source and store that passed the checks, with clean absolute paths.
#[derive(Debug, Clone, Serialize)]
pub struct Checked {
    pub source: String,
    /// "dir" or "file"
    pub source_kind: String,
    pub store_root: String,
    /// The store's id and label, if this folder already is one.
    pub store_id: Option<String>,
    pub store_label: String,
    pub free_bytes: u64,
}

/// System locations beyond the ones a scan skips: places that hold the
/// system or installed software, which must never be moved off the disk.
#[cfg(target_os = "macos")]
const SYSTEM_PATHS: &[&str] = &[
    "/usr", "/bin", "/sbin", "/etc", "/var", "/dev", "/opt", "/cores",
];
#[cfg(all(unix, not(target_os = "macos")))]
const SYSTEM_PATHS: &[&str] = &["/boot", "/opt", "/run", "/snap"];
#[cfg(not(unix))]
const SYSTEM_PATHS: &[&str] = &[];

fn is_system_path(source: &Path) -> bool {
    let fold = |path: &str| {
        if cfg!(target_os = "macos") {
            path.to_lowercase()
        } else {
            path.to_string()
        }
    };
    let source = fold(&source.to_string_lossy());
    SYSTEM_PATHS.iter().any(|prefix| {
        let prefix = fold(prefix);
        source == prefix || source.starts_with(&format!("{prefix}/"))
    })
}

fn canonical(path: &Path, what: &str) -> Result<PathBuf, String> {
    // dunce: plain C:\ paths on Windows rather than \\?\ ones.
    dunce::canonicalize(path)
        .map_err(|e| format!("{what} can't be opened: {} ({e})", path.display()))
}

#[cfg(unix)]
fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_volume(a: &Path, b: &Path) -> bool {
    let prefix = |p: &Path| {
        p.components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
    };
    prefix(a) == prefix(b)
}

/// Check a source and a store folder before anything is written. Every
/// refusal here is something that would otherwise risk data or free nothing.
pub fn preflight(source: &Path, store_root: &Path, options: &Options) -> Result<Checked, String> {
    let link = fs::symlink_metadata(source).map_err(|e| {
        format!(
            "The folder to offload can't be opened: {} ({e})",
            source.display()
        )
    })?;
    if link.file_type().is_symlink() {
        return Err(format!(
            "{} is a link to somewhere else. Offload the real folder instead.",
            source.display()
        ));
    }
    let kind = if link.is_dir() {
        "dir"
    } else if link.is_file() {
        "file"
    } else {
        return Err(format!("{} is not a file or folder.", source.display()));
    };
    let source = canonical(source, "The folder to offload")?;
    let store = canonical(store_root, "The destination folder")?;
    if !store.is_dir() {
        return Err(format!(
            "The destination is not a folder: {}",
            store.display()
        ));
    }

    if source.parent().is_none() {
        return Err("A whole disk can't be offloaded. Pick a folder on it.".into());
    }
    let home = dirs::home_dir().map(|home| dunce::canonicalize(&home).unwrap_or(home));
    if home.is_some_and(|home| home.starts_with(&source)) {
        return Err(format!(
            "{} is your home folder or contains it. Pick a folder inside it.",
            source.display()
        ));
    }
    // The rules a scan of the whole disk would use: system locations are out.
    let disk_root = source.ancestors().last().unwrap_or(&source);
    if IgnoreRules::for_root(disk_root).should_ignore(&source) || is_system_path(&source) {
        return Err(format!(
            "{} is a system location. It can't be offloaded.",
            source.display()
        ));
    }
    let database = default_db_path();
    let database = database
        .parent()
        .and_then(|dir| dunce::canonicalize(dir).ok())
        .unwrap_or(database);
    if database.starts_with(&source) {
        return Err(format!(
            "{} holds this app's own data. Pick a different folder.",
            source.display()
        ));
    }
    if store.starts_with(&source) {
        return Err("The destination is inside the folder being offloaded.".into());
    }
    if source.starts_with(&store) {
        return Err("The folder being offloaded is inside the destination.".into());
    }
    if !options.allow_same_volume && same_volume(&source, &store) {
        return Err("The destination is on the same disk as the folder. Offloading there would free no space; pick a folder on an external drive.".into());
    }

    // Can it be written to?
    let probe = store.join(format!(".di-probe-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&probe, b"probe").map_err(|e| {
        format!(
            "The destination can't be written to: {} ({e})",
            store.display()
        )
    })?;
    let _ = fs::remove_file(&probe);

    let marker = drives::read_marker(&store)?;
    Ok(Checked {
        source: source.to_string_lossy().into_owned(),
        source_kind: kind.into(),
        store_label: marker
            .as_ref()
            .map(|m| m.label.clone())
            .unwrap_or_else(|| drives::volume_name(&store)),
        store_id: marker.map(|m| m.id),
        free_bytes: fs4::available_space(&store).unwrap_or(0),
        store_root: store.to_string_lossy().into_owned(),
    })
}

/// Files and bytes under `source`, for progress and the room check. Returns
/// None if cancelled.
pub fn estimate(source: &Path, cancel: &AtomicBool) -> Option<(u64, u64)> {
    let (mut files, mut bytes) = (0u64, 0u64);
    let Ok(meta) = fs::symlink_metadata(source) else {
        return Some((0, 0));
    };
    if !meta.is_dir() {
        return Some((1, meta.len()));
    }
    let mut stack = vec![source.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(entry.path());
            } else {
                files += 1;
                if kind.is_file() {
                    bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }
    Some((files, bytes))
}

/// Does this folder treat "A" and "a" as the same name?
fn folds_case(dir: &Path) -> bool {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let lower = dir.join(format!(".di-probe-{}", id.to_lowercase()));
    let upper = dir.join(format!(".DI-PROBE-{}", id.to_uppercase()));
    if fs::write(&lower, b"").is_err() {
        return false;
    }
    let folds = fs::symlink_metadata(&upper).is_ok();
    let _ = fs::remove_file(&lower);
    folds
}

// ---------------------------------------------------------------------------
// A job in hand: the pieces offload, release, check and restore share
// ---------------------------------------------------------------------------

struct Work<'a> {
    catalog: &'a mut Catalog,
    ctl: &'a Control<'a>,
    job: JobRecord,
    store_id: String,
    store_root: PathBuf,
    /// The original folder (or file).
    src_root: PathBuf,
    /// Its place on the drive.
    dst_base: PathBuf,
    problems: Problems,
    /// The counts of a removal that stopped part-way (cancel, drive gone), so
    /// what was done is still reported.
    removal_so_far: Option<Removal>,
}

impl Work<'_> {
    fn src(&self, rel: &str) -> Step<PathBuf> {
        join_rel(&self.src_root, rel).ok_or_else(|| Fail::Io("is not a valid path".into()))
    }

    fn dst(&self, rel: &str) -> Step<PathBuf> {
        join_rel(&self.dst_base, rel).ok_or_else(|| Fail::Io("is not a valid path".into()))
    }

    /// After a failure: is the drive still there? If not, stop, rather than
    /// fail every remaining file one by one.
    fn drive_present(&self) -> Step<()> {
        match drives::read_marker(&self.store_root) {
            Ok(Some(marker)) if marker.id == self.store_id => Ok(()),
            _ => Err(Fail::Abort("the drive is no longer connected".into())),
        }
    }

    /// Is the copy of `row` on the drive what the catalog says? Err carries
    /// ("missing" | "damaged", why).
    fn copy_intact(
        &self,
        row: &FileRow,
        read_contents: bool,
    ) -> Step<Result<u64, (&'static str, String)>> {
        let dst = self.dst(&row.rel_path)?;
        let meta = match fs::symlink_metadata(&dst) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Ok(Err((
                    "missing",
                    "the copy is not on the drive any more".into(),
                )))
            }
            Err(e) => {
                return Ok(Err((
                    "missing",
                    format!("the copy on the drive can't be read: {e}"),
                )))
            }
        };
        match row.kind.as_str() {
            "dir" => Ok(if meta.is_dir() {
                Ok(0)
            } else {
                Err(("missing", "the folder is not on the drive any more".into()))
            }),
            "symlink" => {
                let same = meta.file_type().is_symlink()
                    && fs::read_link(&dst)
                        .ok()
                        .and_then(|t| t.to_str().map(str::to_string))
                        == row.link_target;
                Ok(if same {
                    Ok(0)
                } else {
                    Err((
                        "damaged",
                        "the link on the drive points somewhere else now".into(),
                    ))
                })
            }
            _ => {
                if !meta.is_file() || meta.len() != row.size as u64 {
                    return Ok(Err((
                        "damaged",
                        "the copy on the drive has a different size now".into(),
                    )));
                }
                if !read_contents {
                    return Ok(Ok(0));
                }
                match hash_file(self.ctl, &dst, true) {
                    Ok((sha, len)) if Some(&sha) == row.sha256.as_ref() => Ok(Ok(len)),
                    Ok(_) => Ok(Err(("damaged", DAMAGED.into()))),
                    Err(Fail::Io(message)) | Err(Fail::Full(message)) => Ok(Err((
                        "damaged",
                        format!("the copy on the drive can't be read ({message})"),
                    ))),
                    Err(other) => Err(other),
                }
            }
        }
    }

    /// Is the original of `row` still exactly what was copied?
    fn original_unchanged(
        &self,
        row: &FileRow,
        src: &Path,
        meta: &fs::Metadata,
    ) -> Step<Result<(), String>> {
        const CHANGED: &str = "the original changed after it was copied; it was left where it is";
        if row.kind == "symlink" {
            let same = meta.file_type().is_symlink()
                && fs::read_link(src)
                    .ok()
                    .and_then(|t| t.to_str().map(str::to_string))
                    == row.link_target;
            return Ok(if same { Ok(()) } else { Err(CHANGED.into()) });
        }
        if !meta.is_file() {
            return Ok(Err(CHANGED.into()));
        }
        if STRONG_STAMPS && row.src_stamp.as_deref() == Some(stamp(meta).as_str()) {
            return Ok(Ok(()));
        }
        if meta.len() != row.size as u64 {
            return Ok(Err(CHANGED.into()));
        }
        match hash_file(self.ctl, src, false) {
            Ok((sha, _)) if Some(&sha) == row.sha256.as_ref() => Ok(Ok(())),
            Ok(_) => Ok(Err(CHANGED.into())),
            Err(Fail::Io(message)) | Err(Fail::Full(message)) => Ok(Err(format!(
                "the original can't be read ({message}); it was left where it is"
            ))),
            Err(other) => Err(other),
        }
    }

    /// Both checks an original must pass before it may go. Ok(Err(why)) means
    /// keep it.
    fn safe_to_remove(
        &mut self,
        row: &FileRow,
        src: &Path,
        meta: &fs::Metadata,
    ) -> Step<Result<(), String>> {
        // Always from the drive, even for a copy this run made minutes ago:
        // that first read-back may have been answered from memory, and this
        // one is the last chance to notice before the original is gone.
        if let Err((state, why)) = self.copy_intact(row, true)? {
            // A drive pulled out is not a finding about this file.
            self.drive_present()?;
            self.catalog
                .set_drive_state(&self.job.id, &row.rel_path, state)
                .map_err(db)?;
            return Ok(Err(format!("{why}; the original was left where it is")));
        }
        self.original_unchanged(row, src, meta)
    }

    // -- removal -----------------------------------------------------------

    /// Delete each original whose copy is verified, then the folders that
    /// emptied.
    fn delete_originals(&mut self, removal: &mut Removal) -> Step<()> {
        let mut after: Option<String> = None;
        loop {
            let page = self
                .catalog
                .files_after(&self.job.id, after.as_deref(), 500)
                .map_err(db)?;
            let Some(last) = page.last() else { break };
            after = Some(last.rel_path.clone());
            for row in page
                .iter()
                .filter(|r| r.state == "verified" && r.kind != "dir")
            {
                self.ctl.cancelled()?;
                self.delete_original(row, removal)?;
                self.ctl.progress.files_done.fetch_add(1, Ordering::Relaxed);
            }
        }
        self.catalog.commit().map_err(db)?;
        if self.job.source_kind != "dir" {
            return Ok(());
        }
        for rel in self.catalog.dirs_deepest_first(&self.job.id).map_err(db)? {
            let Ok(dir) = self.src(&rel) else { continue };
            self.ctl.hook(Point::RemoveDir, &dir)?;
            // remove_dir only ever removes an empty folder.
            match fs::remove_dir(&dir) {
                Ok(()) => removal.folders_removed += 1,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(_) => removal.folders_left += 1,
            }
        }
        Ok(())
    }

    fn delete_original(&mut self, row: &FileRow, removal: &mut Removal) -> Step<()> {
        let src = self.src(&row.rel_path)?;
        self.ctl.progress.set_current(&row.rel_path);
        self.catalog.settle(row.size as u64).map_err(db)?;
        self.ctl.hook(Point::BeforeRemove, &src)?;
        let meta = match fs::symlink_metadata(&src) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                removal.checked += 1;
                removal.already_gone += 1;
                if !row.source_removed {
                    self.catalog
                        .set_source_removed(&self.job.id, &row.rel_path, true)
                        .map_err(db)?;
                }
                return Ok(());
            }
            Err(e) => {
                removal.checked += 1;
                removal.kept_files += 1;
                self.problems.add(
                    &row.rel_path,
                    "kept",
                    format!("the original can't be read ({e}); it was left where it is"),
                );
                return Ok(());
            }
        };
        // Counted once its fate is known: a check cut short (cancel, drive
        // gone) decided nothing about this one.
        let safe = self.safe_to_remove(row, &src, &meta)?;
        removal.checked += 1;
        if let Err(why) = safe {
            removal.kept_files += 1;
            self.problems.add(&row.rel_path, "kept", why);
            return Ok(());
        }
        let freed = freed_by(&meta);
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut result = fs::remove_file(&src);
        #[cfg(windows)]
        if result.is_err() {
            // A read-only file can't be deleted until the flag is cleared.
            let mut permissions = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            let _ = fs::set_permissions(&src, permissions);
            result = fs::remove_file(&src).or_else(|_| fs::remove_dir(&src));
        }
        match result {
            Ok(()) => {
                removal.removed_files += 1;
                removal.removed_bytes += row.size as u64;
                removal.freed_bytes += freed;
                self.catalog
                    .set_source_removed(&self.job.id, &row.rel_path, true)
                    .map_err(db)?;
                self.ctl.hook(Point::Removed, &src)?;
            }
            Err(e) => {
                removal.kept_files += 1;
                self.problems.add(
                    &row.rel_path,
                    "kept",
                    format!("the original couldn't be removed ({e})"),
                );
            }
        }
        Ok(())
    }

    /// Move the whole source to the Trash, but only if every single thing in
    /// it is verified on the drive and unchanged.
    fn trash_originals(&mut self, removal: &mut Removal) -> Step<()> {
        let mut unsafe_entries = 0u64;
        let (mut files, mut bytes) = (0u64, 0u64);
        let mut stack = vec![String::new()];
        while let Some(rel_dir) = stack.pop() {
            self.ctl.cancelled()?;
            let dir = self.src(&rel_dir)?;
            let meta = match fs::symlink_metadata(&dir) {
                Ok(meta) => meta,
                Err(e) if e.kind() == io::ErrorKind::NotFound && rel_dir.is_empty() => {
                    // Nothing left to move: it is already gone.
                    removal.already_gone = self
                        .catalog
                        .files(&self.job.id)
                        .map_err(db)?
                        .iter()
                        .filter(|r| r.state == "verified" && r.kind != "dir")
                        .count() as u64;
                    self.catalog.mark_all_removed(&self.job.id).map_err(db)?;
                    return Ok(());
                }
                Err(_) => {
                    unsafe_entries += 1;
                    continue;
                }
            };
            if !meta.is_dir() {
                // The source is a single file.
                unsafe_entries +=
                    self.trash_check(&rel_dir, &dir, &meta, removal, &mut files, &mut bytes)?;
                continue;
            }
            let known = self
                .catalog
                .file(&self.job.id, &rel_dir)
                .map_err(db)?
                .is_some_and(|r| r.state == "verified" && r.kind == "dir");
            let entries = match fs::read_dir(&dir) {
                Ok(entries) if known => entries,
                _ => {
                    unsafe_entries += 1;
                    self.problems.add(
                        &rel_dir,
                        "kept",
                        "this folder is not known to be on the drive",
                    );
                    continue;
                }
            };
            for entry in entries {
                let Ok(entry) = entry else {
                    unsafe_entries += 1;
                    continue;
                };
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    unsafe_entries += 1;
                    continue;
                };
                let rel = if rel_dir.is_empty() {
                    name.to_string()
                } else {
                    format!("{rel_dir}/{name}")
                };
                let Ok(meta) = entry.metadata() else {
                    unsafe_entries += 1;
                    continue;
                };
                if meta.is_dir() {
                    stack.push(rel);
                } else {
                    unsafe_entries += self.trash_check(
                        &rel,
                        &entry.path(),
                        &meta,
                        removal,
                        &mut files,
                        &mut bytes,
                    )?;
                }
            }
        }
        if unsafe_entries > 0 {
            removal.kept_files = files + unsafe_entries;
            self.problems.add(
                "",
                "kept",
                format!("{unsafe_entries} item(s) in this folder are not safely on the drive, so nothing was moved to the Trash"),
            );
            return Ok(());
        }
        self.ctl.hook(Point::BeforeRemove, &self.src_root)?;
        let result = match self.ctl.hook.trash(&self.src_root) {
            Some(result) => result,
            None => trash::delete(&self.src_root).map_err(|e| io::Error::other(e.to_string())),
        };
        match result {
            Ok(()) => {
                removal.trashed = true;
                removal.removed_files = files;
                removal.removed_bytes = bytes;
                self.catalog.mark_all_removed(&self.job.id).map_err(db)?;
                self.ctl.hook(Point::Removed, &self.src_root)?;
            }
            Err(e) => {
                removal.kept_files = files;
                self.problems.add(
                    "",
                    "kept",
                    format!("couldn't move the folder to the Trash ({e}); it was left where it is"),
                );
            }
        }
        Ok(())
    }

    /// One entry of the folder about to be trashed: 0 if it is safe, 1 if not.
    fn trash_check(
        &mut self,
        rel: &str,
        src: &Path,
        meta: &fs::Metadata,
        removal: &mut Removal,
        files: &mut u64,
        bytes: &mut u64,
    ) -> Step<u64> {
        removal.checked += 1;
        self.catalog.settle(meta.len()).map_err(db)?;
        let row = self.catalog.file(&self.job.id, rel).map_err(db)?;
        let Some(row) = row.filter(|r| r.state == "verified" && r.kind != "dir") else {
            self.problems.add(rel, "kept", "this is not on the drive");
            return Ok(1);
        };
        match self.safe_to_remove(&row, src, meta)? {
            Ok(()) => {
                *files += 1;
                *bytes += row.size as u64;
                Ok(0)
            }
            Err(why) => {
                self.problems.add(rel, "kept", why);
                Ok(1)
            }
        }
    }

    fn remove_originals(&mut self, mode: RemoveMode) -> Step<Removal> {
        let mut removal = Removal::default();
        // Originals on a disk that isn't connected are not "already gone".
        if mode != RemoveMode::Keep && !source_reachable(&self.src_root) {
            return Err(Fail::Abort(
                "the disk the originals are on is not connected".into(),
            ));
        }
        self.ctl
            .progress
            .phase
            .store(PHASE_REMOVING, Ordering::Relaxed);
        self.ctl.progress.files_done.store(0, Ordering::Relaxed);
        let result = match mode {
            RemoveMode::Keep => Ok(()),
            RemoveMode::Delete => self.delete_originals(&mut removal),
            RemoveMode::Trash => self.trash_originals(&mut removal),
        };
        match result {
            Ok(()) => {}
            Err(Fail::Crash) => return Err(Fail::Crash),
            Err(other) => {
                // What was removed stays recorded; then report the stop.
                self.catalog.commit().map_err(db)?;
                self.removal_so_far = Some(removal);
                return Err(other);
            }
        }
        self.catalog.commit().map_err(db)?;
        Ok(removal)
    }

    // -- the manifest on the drive ----------------------------------------

    /// Write the job's manifest to the drive: one line for the job, then one
    /// per verified entry. With it the catalog can be rebuilt from the drive.
    fn write_manifest(&self) -> Step<()> {
        // Never onto the place where the drive used to be mounted.
        self.drive_present()?;
        let dir = self.store_root.join(MANIFESTS);
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && dir.is_dir() => {}
            Err(e) => {
                return Err(fail(
                    "couldn't write the drive's own list of its contents",
                    e,
                ))
            }
        }
        let mut text = serde_json::to_string(
            &serde_json::json!({ "manifest": 1, "written_at": utc_now(), "job": self.job }),
        )
        .expect("serializable");
        text.push('\n');
        let mut after: Option<String> = None;
        loop {
            let page = self
                .catalog
                .files_after(&self.job.id, after.as_deref(), 1000)
                .map_err(db)?;
            let Some(last) = page.last() else { break };
            after = Some(last.rel_path.clone());
            for row in page.iter().filter(|r| r.state == "verified") {
                text.push_str(&serde_json::to_string(row).expect("serializable"));
                text.push('\n');
            }
        }
        write_atomically(&dir.join(format!("{}.jsonl", self.job.id)), text.as_bytes())
            .map_err(|e| fail("couldn't write the drive's own list of its contents", e))
    }
}

// ---------------------------------------------------------------------------
// Offload
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Counts {
    items_seen: u64,
    bytes_seen: u64,
    copied_files: u64,
    copied_bytes: u64,
    already_files: u64,
    already_bytes: u64,
    failed: u64,
    skipped: u64,
}

struct Copy<'w, 'a> {
    work: &'w mut Work<'a>,
    counts: Counts,
    folds_case: bool,
    #[cfg(unix)]
    root_dev: u64,
}

impl Copy<'_, '_> {
    fn problem(&mut self, rel: &str, kind: &str, state: &str, message: String) -> Step<()> {
        self.counts.items_seen += 1;
        if state == "skipped" {
            self.counts.skipped += 1;
        } else {
            self.counts.failed += 1;
        }
        self.work
            .ctl
            .progress
            .problems
            .fetch_add(1, Ordering::Relaxed);
        self.work.problems.add(rel, state, message.clone());
        self.work
            .catalog
            .record_problem(&self.work.job.id, rel, kind, state, &message)
            .map_err(db)
    }

    fn run(&mut self) -> Step<()> {
        let ctl = self.work.ctl;
        ctl.progress.phase.store(PHASE_COPYING, Ordering::Relaxed);
        if self.work.job.source_kind == "file" {
            let (src, dst) = (self.work.src_root.clone(), self.work.dst_base.clone());
            let parent = dst
                .parent()
                .ok_or_else(|| Fail::Abort("the destination has no parent folder".into()))?
                .to_path_buf();
            fs::create_dir_all(&parent)
                .map_err(|e| Fail::Abort(format!("couldn't create a folder on the drive: {e}")))?;
            sync_up_to(&parent, &self.work.store_root);
            clear_stale_parts(&parent);
            self.file(&src, "", &dst)?;
            sync_dir(&parent);
            return Ok(());
        }
        fs::create_dir_all(&self.work.dst_base)
            .map_err(|e| Fail::Abort(format!("couldn't create a folder on the drive: {e}")))?;
        sync_up_to(&self.work.dst_base, &self.work.store_root);
        let mut stack = vec![String::new()];
        while let Some(rel_dir) = stack.pop() {
            ctl.cancelled()?;
            self.dir(&rel_dir, &mut stack)?;
        }
        Ok(())
    }

    fn dir(&mut self, rel_dir: &str, stack: &mut Vec<String>) -> Step<()> {
        let (src_dir, dst_dir) = (self.work.src(rel_dir)?, self.work.dst(rel_dir)?);
        // A folder swapped for a link since it was listed is not followed.
        if !is_real_dir(&src_dir) {
            return self.problem(
                rel_dir,
                "dir",
                "failed",
                "this is not a folder any more; nothing in it was copied".into(),
            );
        }
        let read = fs::read_dir(&src_dir).and_then(|entries| {
            let mut list: Vec<(OsString, fs::FileType)> = Vec::new();
            for entry in entries {
                let entry = entry?;
                list.push((entry.file_name(), entry.file_type()?));
            }
            Ok(list)
        });
        let mut entries = match read {
            Ok(entries) => entries,
            // Not an empty folder: a folder whose contents are unknown.
            Err(e) => {
                return self.problem(
                    rel_dir,
                    "dir",
                    "failed",
                    format!("this folder couldn't be read ({e}); nothing in it was copied"),
                )
            }
        };
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        if !rel_dir.is_empty() {
            match fs::create_dir(&dst_dir) {
                // The new folder's name lives in its parent: flush that too,
                // or a power cut could leave verified files in a folder the
                // drive has no record of.
                Ok(()) => {
                    if let Some(parent) = dst_dir.parent() {
                        sync_dir(parent);
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists && is_real_dir(&dst_dir) => {}
                Err(e) => {
                    let failure = fail("the folder couldn't be created on the drive", e);
                    let (Fail::Io(message) | Fail::Full(message)) = &failure else {
                        return Err(failure);
                    };
                    self.problem(
                        rel_dir,
                        "dir",
                        "failed",
                        format!("{message}; nothing in it was copied"),
                    )?;
                    self.work.drive_present()?;
                    return if matches!(failure, Fail::Full(_)) {
                        Err(Fail::Abort("the drive is full".into()))
                    } else {
                        Ok(())
                    };
                }
            }
        }
        clear_stale_parts(&dst_dir);
        let meta = fs::symlink_metadata(&src_dir).ok();
        self.work
            .catalog
            .record_verified(&FileRow {
                job_id: self.work.job.id.clone(),
                rel_path: rel_dir.to_string(),
                kind: "dir".into(),
                mtime_ns: meta.as_ref().map(mtime_ns),
                mode: meta.as_ref().and_then(mode_of),
                state: "verified".into(),
                ..FileRow::default()
            })
            .map_err(db)?;

        // Names that differ only by case can't both live on a drive that
        // ignores case; copying one would shadow the other.
        let mut clashes: HashMap<String, u32> = HashMap::new();
        if self.folds_case {
            for (name, _) in &entries {
                *clashes
                    .entry(name.to_string_lossy().to_lowercase())
                    .or_default() += 1;
            }
        }

        let mut subdirs = Vec::new();
        for (name, kind) in entries {
            self.work.ctl.cancelled()?;
            let Some(name) = name.to_str() else {
                let shown = name.to_string_lossy();
                let rel = if rel_dir.is_empty() {
                    shown.into_owned()
                } else {
                    format!("{rel_dir}/{shown}")
                };
                self.problem(&rel, "file", "failed", "its name is not valid Unicode, so it can't be tracked; it was left where it is".into())?;
                continue;
            };
            let rel = if rel_dir.is_empty() {
                name.to_string()
            } else {
                format!("{rel_dir}/{name}")
            };
            let entry_kind = if kind.is_dir() {
                "dir"
            } else if kind.is_symlink() {
                "symlink"
            } else {
                "file"
            };
            if name.starts_with(TMP_PREFIX) {
                self.problem(
                    &rel,
                    entry_kind,
                    "skipped",
                    "a leftover of an interrupted copy; it was left where it is".into(),
                )?;
                continue;
            }
            if clashes.get(&name.to_lowercase()).copied().unwrap_or(0) > 1 {
                self.problem(&rel, entry_kind, "failed", "another name here differs only by upper/lower case, and this drive can't hold both; it was left where it is".into())?;
                continue;
            }
            let (src, dst) = (src_dir.join(name), dst_dir.join(name));
            if kind.is_dir() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if fs::symlink_metadata(&src)
                        .map(|m| m.dev())
                        .unwrap_or(self.root_dev)
                        != self.root_dev
                    {
                        self.problem(
                            &rel,
                            "dir",
                            "failed",
                            "another disk is mounted here; it was not copied".into(),
                        )?;
                        continue;
                    }
                }
                subdirs.push(rel);
            } else if kind.is_file() {
                self.file(&src, &rel, &dst)?;
            } else if kind.is_symlink() {
                self.link(&src, &rel, &dst)?;
            } else {
                self.problem(
                    &rel,
                    "file",
                    "skipped",
                    "not a regular file (a socket, pipe or device); it was left where it is".into(),
                )?;
            }
        }
        sync_dir(&dst_dir);
        // Popped in name order.
        stack.extend(subdirs.into_iter().rev());
        Ok(())
    }

    /// One file: on the drive and verified, or a recorded failure.
    fn file(&mut self, src: &Path, rel: &str, dst: &Path) -> Step<()> {
        let ctl = self.work.ctl;
        ctl.progress.set_current(rel);
        let size = fs::symlink_metadata(src).map(|m| m.len()).unwrap_or(0);
        self.work.catalog.settle(size).map_err(db)?;
        let outcome = ctl
            .hook(Point::FileStart, src)
            .and_then(|()| self.place_file(src, dst));
        ctl.progress.files_done.fetch_add(1, Ordering::Relaxed);
        match outcome {
            Ok((copied, fresh)) => {
                self.counts.items_seen += 1;
                self.counts.bytes_seen += copied.size;
                if fresh {
                    self.counts.copied_files += 1;
                    self.counts.copied_bytes += copied.size;
                } else {
                    self.counts.already_files += 1;
                    self.counts.already_bytes += copied.size;
                }
                self.work
                    .catalog
                    .record_verified(&FileRow {
                        job_id: self.work.job.id.clone(),
                        rel_path: rel.to_string(),
                        kind: "file".into(),
                        size: copied.size as i64,
                        mtime_ns: Some(copied.mtime_ns),
                        mode: copied.mode,
                        sha256: Some(copied.sha256),
                        src_stamp: copied.stamp,
                        state: "verified".into(),
                        ..FileRow::default()
                    })
                    .map_err(db)?;
                ctl.hook(Point::Recorded, dst)
            }
            Err(Fail::Io(message)) => {
                self.problem(rel, "file", "failed", message)?;
                self.work.drive_present()
            }
            Err(Fail::Full(message)) => {
                self.problem(rel, "file", "failed", message)?;
                Err(Fail::Abort("the drive is full".into()))
            }
            Err(other) => Err(other),
        }
    }

    /// Copy the file, or accept one already on the drive if (and only if) its
    /// contents are the same. Returns the copy and whether this run wrote it.
    fn place_file(&mut self, src: &Path, dst: &Path) -> Step<(Copied, bool)> {
        let ctl = self.work.ctl;
        let existing = match fs::symlink_metadata(dst) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return copy_verified(ctl, src, dst, None).map(|c| (c, true))
            }
            Err(e) => return Err(fail("the destination can't be read", e)),
        };
        const CONFLICT: &str = "a different file with this name is already on the drive; it was not overwritten and the original was left where it is";
        if !existing.is_file() {
            return Err(Fail::Io(CONFLICT.into()));
        }
        let before = fs::symlink_metadata(src).map_err(|e| fail("couldn't read", e))?;
        if !before.is_file() {
            return Err(Fail::Io("is not a regular file any more".into()));
        }
        if existing.len() != before.len() {
            return Err(Fail::Io(CONFLICT.into()));
        }
        let (source_sha, size) = hash_file(ctl, src, false)?;
        ctl.progress.bytes_done.fetch_add(size, Ordering::Relaxed);
        let after = fs::symlink_metadata(src).map_err(|e| fail("couldn't read", e))?;
        if stamp(&after) != stamp(&before) {
            return Err(Fail::Io(
                "changed while it was being compared; it was left where it is".into(),
            ));
        }
        let (drive_sha, _) = hash_file(ctl, dst, true)?;
        if drive_sha != source_sha {
            return Err(Fail::Io(CONFLICT.into()));
        }
        Ok((
            Copied {
                sha256: source_sha,
                size,
                stamp: settled_stamp(&after),
                mtime_ns: mtime_ns(&before),
                mode: mode_of(&before),
            },
            false,
        ))
    }

    fn link(&mut self, src: &Path, rel: &str, dst: &Path) -> Step<()> {
        let ctl = self.work.ctl;
        ctl.progress.set_current(rel);
        let outcome = ctl.hook(Point::FileStart, src).and_then(|()| {
            let target = link_target(src)?;
            let fresh = match fs::symlink_metadata(dst) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    make_link(&target, dst).map_err(|e| fail("this drive can't store links, so the link was left where it is", e))?;
                    true
                }
                Ok(_) => false,
                Err(e) => return Err(fail("the destination can't be read", e)),
            };
            // Read it back, whoever made it.
            let stored = fs::read_link(dst).ok().and_then(|t| t.to_str().map(str::to_string));
            if stored.as_deref() != Some(target.as_str()) {
                return Err(Fail::Io("something different with this name is already on the drive; it was not overwritten".into()));
            }
            let meta = fs::symlink_metadata(src).map_err(|e| fail("couldn't read", e))?;
            Ok((target, fresh, meta))
        });
        ctl.progress.files_done.fetch_add(1, Ordering::Relaxed);
        match outcome {
            Ok((target, fresh, meta)) => {
                self.counts.items_seen += 1;
                if fresh {
                    self.counts.copied_files += 1;
                } else {
                    self.counts.already_files += 1;
                }
                self.work
                    .catalog
                    .record_verified(&FileRow {
                        job_id: self.work.job.id.clone(),
                        rel_path: rel.to_string(),
                        kind: "symlink".into(),
                        mtime_ns: Some(mtime_ns(&meta)),
                        link_target: Some(target),
                        src_stamp: Some(stamp(&meta)),
                        state: "verified".into(),
                        ..FileRow::default()
                    })
                    .map_err(db)?;
                ctl.hook(Point::Recorded, dst)
            }
            Err(Fail::Io(message)) | Err(Fail::Full(message)) => {
                self.problem(rel, "symlink", "failed", message)?;
                self.work.drive_present()
            }
            Err(other) => Err(other),
        }
    }
}

/// Copy `source` to the store at `store_root`, verify every file, record it
/// all in the catalog and on the drive, and then (if asked) remove the
/// originals. Safe to run again after any kind of stop: it resumes.
pub fn offload(
    catalog: &mut Catalog,
    source: &Path,
    store_root: &Path,
    options: &Options,
    ctl: &Control,
) -> Result<Report, String> {
    let checked = preflight(source, store_root, options)?;
    let (source, store_root) = (
        PathBuf::from(&checked.source),
        PathBuf::from(&checked.store_root),
    );
    let host = host_name();
    let rel_base = rel_base_for(&host, &source)?;
    let dst_base = join_rel(&store_root, &rel_base).ok_or_else(|| {
        format!(
            "{} can't be stored under its own path on the drive",
            source.display()
        )
    })?;

    // How much there is, and whether it fits. A resumed job may already have
    // most of it there, so only a fresh one is refused for room up front; a
    // drive that fills up later stops the run without touching the originals.
    ctl.progress.phase.store(PHASE_COUNTING, Ordering::Relaxed);
    let Some((files, bytes)) = estimate(&source, ctl.cancel) else {
        return Err("Cancelled before anything was copied.".into());
    };
    ctl.progress.files_total.store(files, Ordering::Relaxed);
    ctl.progress.bytes_total.store(bytes, Ordering::Relaxed);
    if fs::symlink_metadata(&dst_base).is_err() {
        let margin = (bytes / 100).max(16 * 1024 * 1024);
        if checked.free_bytes < bytes.saturating_add(margin) {
            return Err(format!(
                "Not enough room on the drive: this needs {} plus {} to spare, and {} is free. Nothing was copied.",
                format_bytes(bytes),
                format_bytes(margin),
                format_bytes(checked.free_bytes)
            ));
        }
    }

    let marker = drives::ensure_marker(&store_root)?;
    let sql = |e: rusqlite::Error| format!("The catalog couldn't be written: {e}");
    catalog
        .upsert_store(
            &marker.id,
            &marker.label,
            &checked.store_root,
            &marker.created_at,
        )
        .map_err(sql)?;
    if let Some(unfinished) = catalog
        .find_job(&marker.id, &host, &checked.source)
        .map_err(sql)?
        .filter(|job| job.state == "running")
    {
        // The last run on this folder never finished: start from what is true.
        reconcile(catalog, &unfinished).map_err(sql)?;
    }
    let job = catalog
        .open_job(
            &marker.id,
            &host,
            &checked.source,
            &checked.source_kind,
            &rel_base,
        )
        .map_err(sql)?;

    let mut work = Work {
        catalog,
        ctl,
        job,
        store_id: marker.id.clone(),
        store_root: store_root.clone(),
        src_root: source.clone(),
        dst_base: dst_base.clone(),
        problems: Problems::default(),
        removal_so_far: None,
    };

    // What an earlier run could not copy is found again by this one, or is
    // no longer true.
    work.catalog.clear_problems(&work.job.id).map_err(sql)?;

    let folds_case = ctl
        .hook
        .folds_case()
        .unwrap_or_else(|| folds_case(&store_root));
    #[cfg(unix)]
    let root_dev = {
        use std::os::unix::fs::MetadataExt;
        fs::symlink_metadata(&source).map(|m| m.dev()).unwrap_or(0)
    };
    let mut copy = Copy {
        work: &mut work,
        counts: Counts::default(),
        folds_case,
        #[cfg(unix)]
        root_dev,
    };
    let copied = copy.run();
    let counts = std::mem::take(&mut copy.counts);

    // A crash ends here, with whatever reached the disk.
    if matches!(copied, Err(Fail::Crash)) {
        work.catalog.rollback();
        return Err(CRASHED.into());
    }
    work.catalog.commit().map_err(sql)?;

    let mut outcome = "complete";
    let mut stopped = None;
    match copied {
        Ok(()) => {}
        Err(Fail::Cancelled) => outcome = "cancelled",
        Err(Fail::Abort(reason)) | Err(Fail::Io(reason)) | Err(Fail::Full(reason)) => {
            outcome = "incomplete";
            stopped = Some(reason);
        }
        Err(Fail::Crash) => unreachable!("handled above"),
    }
    if counts.failed + counts.skipped > 0 && outcome == "complete" {
        outcome = "incomplete";
    }

    // The drive's own record of what it holds, before any original goes.
    let manifest = ctl
        .hook(Point::Manifest, &store_root)
        .and_then(|()| work.write_manifest());
    match manifest {
        Ok(()) => {}
        Err(Fail::Crash) => return Err(CRASHED.into()),
        Err(Fail::Cancelled) => outcome = "cancelled",
        Err(Fail::Abort(reason)) | Err(Fail::Io(reason)) | Err(Fail::Full(reason)) => {
            if stopped.is_none() {
                outcome = "incomplete";
                stopped = Some(reason);
            }
        }
    }

    // Originals go only after a run that reached the end with the manifest
    // written. Individual failures don't block the rest in Delete mode;
    // Trash is all or nothing.
    let mut removal = Removal::default();
    if stopped.is_none() && outcome != "cancelled" && options.remove != RemoveMode::Keep {
        match work.remove_originals(options.remove) {
            Ok(done) => removal = done,
            Err(Fail::Crash) => {
                work.catalog.rollback();
                return Err(CRASHED.into());
            }
            Err(Fail::Cancelled) => {
                outcome = "cancelled";
                removal = work.removal_so_far.take().unwrap_or_default();
            }
            Err(Fail::Abort(reason)) | Err(Fail::Io(reason)) | Err(Fail::Full(reason)) => {
                stopped = Some(reason);
                removal = work.removal_so_far.take().unwrap_or_default();
            }
        }
    }

    // The job's state is about the copy: is everything on the drive? The
    // run's outcome also covers the removal that was asked for.
    let state = if outcome == "complete" {
        "complete"
    } else {
        "incomplete"
    };
    work.catalog.finish_job(&work.job.id, state).map_err(sql)?;
    if outcome == "complete" && (stopped.is_some() || removal.kept_files > 0) {
        outcome = "incomplete";
    }
    work.catalog.commit().map_err(sql)?;

    let Problems { list, total } = std::mem::take(&mut work.problems);
    Ok(Report {
        job_id: work.job.id.clone(),
        store_id: marker.id,
        store_label: marker.label,
        source: checked.source,
        dest: dst_base.to_string_lossy().into_owned(),
        outcome: outcome.into(),
        stopped,
        items_seen: counts.items_seen,
        bytes_seen: counts.bytes_seen,
        copied_files: counts.copied_files,
        copied_bytes: counts.copied_bytes,
        already_files: counts.already_files,
        already_bytes: counts.already_bytes,
        verified_files: counts.copied_files + counts.already_files,
        verified_bytes: counts.copied_bytes + counts.already_bytes,
        failed: counts.failed,
        skipped: counts.skipped,
        removal,
        problems: list,
        problems_total: total,
    })
}

// ---------------------------------------------------------------------------
// Release, check, restore, import
// ---------------------------------------------------------------------------

/// Can anything be said about the originals under `root`? Not when the
/// folder it sat in is gone too: that is a disk that isn't connected, not a
/// folder that was removed.
fn source_reachable(root: &Path) -> bool {
    fs::symlink_metadata(root).is_ok()
        || root
            .parent()
            .is_some_and(|parent| fs::symlink_metadata(parent).is_ok())
}

/// Open a job whose drive is connected.
fn work_on<'a>(
    catalog: &'a mut Catalog,
    job_id: &str,
    ctl: &'a Control<'a>,
) -> Result<Work<'a>, String> {
    let sql = |e: rusqlite::Error| format!("The catalog couldn't be read: {e}");
    let job = catalog
        .job(job_id)
        .map_err(sql)?
        .ok_or_else(|| format!("No such offload: {job_id}"))?;
    let store = catalog.store(&job.store_id).map_err(sql)?.ok_or_else(|| {
        format!(
            "The drive for this offload is not in the catalog: {}",
            job.store_id
        )
    })?;
    let store_root = drives::locate(&store).ok_or_else(|| {
        format!(
            "The drive \"{}\" is not connected. Plug it in and try again.",
            store.label
        )
    })?;
    catalog
        .store_seen(&store.id, &store_root.to_string_lossy())
        .map_err(sql)?;
    let dst_base = join_rel(&store_root, &job.rel_base)
        .ok_or("This offload's place on the drive is not a valid path.")?;
    let (files, bytes) = catalog.verified_totals(&job.id).map_err(sql)?;
    ctl.progress.files_total.store(files, Ordering::Relaxed);
    ctl.progress.bytes_total.store(bytes, Ordering::Relaxed);
    Ok(Work {
        catalog,
        ctl,
        src_root: PathBuf::from(&job.source_path),
        job,
        store_id: store.id,
        store_root,
        dst_base,
        problems: Problems::default(),
        removal_so_far: None,
    })
}

/// Bring `source_removed` in line with what is on this computer. After a run
/// that was cut short, the last few removals may not have reached the
/// catalog. No decision ever rests on the flag, but people read it.
fn reconcile(catalog: &mut Catalog, job: &JobRecord) -> rusqlite::Result<()> {
    let root = PathBuf::from(&job.source_path);
    if !source_reachable(&root) {
        return Ok(());
    }
    let mut after: Option<String> = None;
    loop {
        let page = catalog.files_after(&job.id, after.as_deref(), 500)?;
        let Some(last) = page.last() else { break };
        after = Some(last.rel_path.clone());
        for row in page
            .iter()
            .filter(|r| r.state == "verified" && r.kind != "dir")
        {
            let Some(src) = join_rel(&root, &row.rel_path) else {
                continue;
            };
            let gone =
                matches!(fs::symlink_metadata(&src), Err(e) if e.kind() == io::ErrorKind::NotFound);
            if gone != row.source_removed {
                catalog.set_source_removed(&job.id, &row.rel_path, gone)?;
            }
        }
    }
    catalog.commit()
}

/// Tidy up after runs that never finished (a crash, a power cut, the app
/// being killed): correct their records of which originals are gone, and
/// mark them incomplete. Call when no run is under way, e.g. as the app
/// starts. Returns how many jobs it found.
pub fn recover(catalog: &mut Catalog) -> Result<u64, String> {
    let sql = |e: rusqlite::Error| format!("The catalog couldn't be written: {e}");
    let host = host_name();
    let mut found = 0;
    for summary in catalog.jobs().map_err(sql)? {
        if summary.job.state != "running" {
            continue;
        }
        found += 1;
        if summary.job.host == host {
            reconcile(catalog, &summary.job).map_err(sql)?;
        }
        catalog
            .finish_job(&summary.job.id, "incomplete")
            .map_err(sql)?;
    }
    Ok(found)
}

/// Remove the originals of a job that was offloaded with them kept. Every
/// copy is read back from the drive first.
pub fn release(
    catalog: &mut Catalog,
    job_id: &str,
    mode: RemoveMode,
    ctl: &Control,
) -> Result<ReleaseReport, String> {
    if mode == RemoveMode::Keep {
        return Err("Nothing to do: the originals are being kept.".into());
    }
    let mut work = work_on(catalog, job_id, ctl)?;
    if work.job.host != host_name() {
        return Err(format!(
            "This offload was made on another computer ({}); its originals are not here.",
            work.job.host
        ));
    }
    let mut report = ReleaseReport {
        job_id: job_id.into(),
        outcome: "complete".into(),
        ..ReleaseReport::default()
    };
    // The drive's own list first, as in an offload: the run that made these
    // copies may have been cut short before it wrote one.
    let removed = ctl
        .hook(Point::Manifest, &work.store_root)
        .and_then(|()| work.write_manifest())
        .and_then(|()| work.remove_originals(mode));
    match removed {
        Ok(removal) => report.removal = removal,
        Err(Fail::Crash) => {
            work.catalog.rollback();
            return Err(CRASHED.into());
        }
        Err(Fail::Cancelled) => {
            report.outcome = "cancelled".into();
            report.removal = work.removal_so_far.take().unwrap_or_default();
        }
        Err(Fail::Abort(reason)) | Err(Fail::Io(reason)) | Err(Fail::Full(reason)) => {
            report.outcome = "incomplete".into();
            report.stopped = Some(reason);
            report.removal = work.removal_so_far.take().unwrap_or_default();
        }
    }
    if report.removal.kept_files > 0 && report.outcome == "complete" {
        report.outcome = "incomplete".into();
    }
    let Problems { list, total } = std::mem::take(&mut work.problems);
    report.problems = list;
    report.problems_total = total;
    Ok(report)
}

/// Read every file of a job back from the drive and compare it with the
/// catalog. Finds files that went missing or rotted since they were copied.
pub fn check(catalog: &mut Catalog, job_id: &str, ctl: &Control) -> Result<CheckReport, String> {
    let sql = |e: rusqlite::Error| format!("The catalog couldn't be written: {e}");
    let mut work = work_on(catalog, job_id, ctl)?;
    ctl.progress.phase.store(PHASE_CHECKING, Ordering::Relaxed);
    let mut report = CheckReport {
        job_id: job_id.into(),
        outcome: "ok".into(),
        ..CheckReport::default()
    };
    let mut after: Option<String> = None;
    let run: Step<()> = (|| loop {
        let page = work
            .catalog
            .files_after(job_id, after.as_deref(), 500)
            .map_err(db)?;
        let Some(last) = page.last() else {
            return Ok(());
        };
        after = Some(last.rel_path.clone());
        for row in page.iter().filter(|r| r.state == "verified") {
            ctl.cancelled()?;
            ctl.progress.set_current(&row.rel_path);
            work.catalog.settle(row.size as u64).map_err(db)?;
            report.checked += 1;
            let state = match work.copy_intact(row, true)? {
                Ok(read) => {
                    report.ok += 1;
                    report.bytes_read += read;
                    ctl.progress.bytes_done.fetch_add(read, Ordering::Relaxed);
                    "ok"
                }
                Err((state, why)) => {
                    // A drive pulled out is not a finding about this file.
                    work.drive_present()?;
                    if state == "missing" {
                        report.missing += 1;
                    } else {
                        report.damaged += 1;
                    }
                    work.problems.add(&row.rel_path, state, why);
                    state
                }
            };
            ctl.progress.files_done.fetch_add(1, Ordering::Relaxed);
            if row.drive_state.as_deref() != Some(state) {
                work.catalog
                    .set_drive_state(job_id, &row.rel_path, state)
                    .map_err(db)?;
            }
        }
    })();
    match run {
        Ok(()) => {
            work.catalog.commit().map_err(sql)?;
            let problems = (report.missing + report.damaged) as i64;
            work.catalog.job_checked(job_id, problems).map_err(sql)?;
            if problems > 0 {
                report.outcome = "problems".into();
            }
        }
        Err(Fail::Cancelled) => {
            work.catalog.commit().map_err(sql)?;
            report.outcome = "cancelled".into();
        }
        Err(Fail::Crash) => {
            work.catalog.rollback();
            return Err(CRASHED.into());
        }
        Err(Fail::Abort(reason)) | Err(Fail::Io(reason)) | Err(Fail::Full(reason)) => {
            // Half a check says nothing reliable: record none of it.
            work.catalog.rollback();
            return Err(format!(
                "The check stopped: {reason}. Nothing was recorded."
            ));
        }
    }
    let Problems { list, total } = std::mem::take(&mut work.problems);
    report.problems = list;
    report.problems_total = total;
    Ok(report)
}

/// Copy a job (or one file or folder in it) back from the drive, verified
/// against the catalog's checksums. Goes to where it came from unless `to`
/// names another folder. Never overwrites a file that differs; the drive's
/// copy is left as it is.
pub fn restore(
    catalog: &mut Catalog,
    job_id: &str,
    only: Option<&str>,
    to: Option<&Path>,
    ctl: &Control,
) -> Result<RestoreReport, String> {
    let sql = |e: rusqlite::Error| format!("The catalog couldn't be written: {e}");
    let mut work = work_on(catalog, job_id, ctl)?;
    let home_again = to.is_none();
    if home_again && work.job.host != host_name() {
        return Err(format!(
            "This offload was made on another computer ({}). Choose a folder to restore it into.",
            work.job.host
        ));
    }
    let target_root = to
        .map(Path::to_path_buf)
        .unwrap_or_else(|| work.src_root.clone());
    let only = only
        .map(|p| p.trim_matches('/').to_string())
        .filter(|p| !p.is_empty());
    if let Some(prefix) = &only {
        if join_rel(Path::new(""), prefix).is_none() {
            return Err(format!("Not a path inside this offload: {prefix}"));
        }
    }
    ctl.progress.phase.store(PHASE_RESTORING, Ordering::Relaxed);
    let mut report = RestoreReport {
        job_id: job_id.into(),
        target: target_root.to_string_lossy().into_owned(),
        outcome: "complete".into(),
        ..RestoreReport::default()
    };
    let wanted = |rel: &str| match &only {
        None => true,
        Some(prefix) => {
            rel == prefix
                || rel
                    .strip_prefix(prefix.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        }
    };

    let mut after: Option<String> = None;
    let run: Step<()> = (|| loop {
        let page = work
            .catalog
            .files_after(job_id, after.as_deref(), 500)
            .map_err(db)?;
        let Some(last) = page.last() else {
            return Ok(());
        };
        after = Some(last.rel_path.clone());
        for row in page
            .iter()
            .filter(|r| r.state == "verified" && wanted(&r.rel_path))
        {
            ctl.cancelled()?;
            ctl.progress.set_current(&row.rel_path);
            work.catalog.settle(row.size as u64).map_err(db)?;
            let placed = restore_one(&work, row, &target_root);
            if row.kind != "dir" {
                ctl.progress.files_done.fetch_add(1, Ordering::Relaxed);
            }
            match placed {
                Ok(Placed::Folder) => {}
                Ok(placed) => {
                    if matches!(placed, Placed::Copied) {
                        report.restored_files += 1;
                        report.restored_bytes += row.size as u64;
                    } else {
                        report.already_files += 1;
                    }
                    if home_again && row.source_removed {
                        work.catalog
                            .set_source_removed(job_id, &row.rel_path, false)
                            .map_err(db)?;
                    }
                }
                Err(Fail::Io(message)) => {
                    report.failed += 1;
                    if message == DAMAGED {
                        work.catalog
                            .set_drive_state(job_id, &row.rel_path, "damaged")
                            .map_err(db)?;
                    }
                    work.problems.add(&row.rel_path, "failed", message);
                    work.drive_present()?;
                }
                Err(Fail::Full(message)) => {
                    report.failed += 1;
                    work.problems.add(&row.rel_path, "failed", message);
                    return Err(Fail::Abort("this computer's disk is full".into()));
                }
                Err(other) => return Err(other),
            }
        }
    })();
    match run {
        Ok(()) => {}
        Err(Fail::Cancelled) => report.outcome = "cancelled".into(),
        Err(Fail::Crash) => {
            work.catalog.rollback();
            return Err(CRASHED.into());
        }
        Err(Fail::Abort(reason)) | Err(Fail::Io(reason)) | Err(Fail::Full(reason)) => {
            report.outcome = "incomplete".into();
            report.stopped = Some(reason);
        }
    }
    work.catalog.commit().map_err(sql)?;
    if report.failed > 0 && report.outcome == "complete" {
        report.outcome = "incomplete".into();
    }
    let Problems { list, total } = std::mem::take(&mut work.problems);
    report.problems = list;
    report.problems_total = total;
    Ok(report)
}

enum Placed {
    Folder,
    Copied,
    AlreadyThere,
}

fn restore_one(work: &Work, row: &FileRow, target_root: &Path) -> Step<Placed> {
    const CONFLICT: &str = "something different is already there; it was not overwritten";
    let from = work.dst(&row.rel_path)?;
    let to = join_rel(target_root, &row.rel_path)
        .ok_or_else(|| Fail::Io("is not a valid path".into()))?;
    // Never write through a link: a folder on the way that is really a link
    // (put there since, or named by a doctored list on the drive) would send
    // the file somewhere else.
    let mut above = to.parent();
    while let Some(folder) = above.filter(|f| f.starts_with(target_root) && *f != target_root) {
        if fs::symlink_metadata(folder).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(Fail::Io(
                "a link is in the way where this belongs; nothing was written through it".into(),
            ));
        }
        above = folder.parent();
    }
    let existing = fs::symlink_metadata(&to).ok();
    match row.kind.as_str() {
        "dir" => match existing {
            Some(meta) if meta.is_dir() => Ok(Placed::Folder),
            Some(_) => Err(Fail::Io(CONFLICT.into())),
            None => fs::create_dir_all(&to)
                .map(|()| Placed::Folder)
                .map_err(|e| fail("couldn't create the folder", e)),
        },
        "symlink" => {
            let target = row
                .link_target
                .as_deref()
                .ok_or_else(|| Fail::Io("the catalog has no target for this link".into()))?;
            match existing {
                Some(meta)
                    if meta.file_type().is_symlink()
                        && fs::read_link(&to)
                            .ok()
                            .and_then(|t| t.to_str().map(str::to_string))
                            .as_deref()
                            == Some(target) =>
                {
                    Ok(Placed::AlreadyThere)
                }
                Some(_) => Err(Fail::Io(CONFLICT.into())),
                None => {
                    if let Some(parent) = to.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| fail("couldn't create the folder", e))?;
                    }
                    make_link(target, &to)
                        .map(|()| Placed::Copied)
                        .map_err(|e| fail("couldn't create the link", e))
                }
            }
        }
        _ => {
            let expected = row
                .sha256
                .as_deref()
                .ok_or_else(|| Fail::Io("the catalog has no checksum for this file".into()))?;
            match existing {
                Some(meta) if meta.is_file() && meta.len() == row.size as u64 => {
                    match hash_file(work.ctl, &to, false)? {
                        (sha, _) if sha == expected => Ok(Placed::AlreadyThere),
                        _ => Err(Fail::Io(CONFLICT.into())),
                    }
                }
                Some(_) => Err(Fail::Io(CONFLICT.into())),
                None => {
                    let parent = to
                        .parent()
                        .ok_or_else(|| Fail::Io("has no parent folder".into()))?;
                    fs::create_dir_all(parent)
                        .map_err(|e| fail("couldn't create the folder", e))?;
                    copy_verified(work.ctl, &from, &to, Some(expected))?;
                    // The time and permissions the original had, from the
                    // catalog: the drive's file system may not have kept them.
                    if let Some(ns) = row.mtime_ns.filter(|ns| *ns >= 0) {
                        let when =
                            std::time::UNIX_EPOCH + std::time::Duration::from_nanos(ns as u64);
                        let _ = fs::OpenOptions::new()
                            .write(true)
                            .open(&to)
                            .and_then(|f| f.set_modified(when));
                    }
                    #[cfg(unix)]
                    if let Some(mode) = row.mode {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = fs::set_permissions(
                            &to,
                            fs::Permissions::from_mode(mode as u32 & 0o7777),
                        );
                    }
                    sync_dir(parent);
                    Ok(Placed::Copied)
                }
            }
        }
    }
}

/// Add what a drive says it holds (its manifests) to the catalog. For a
/// drive whose offloads were made by another computer, or after this
/// computer's database was lost. Jobs already in the catalog are left alone.
pub fn import_store(catalog: &mut Catalog, store_root: &Path) -> Result<ImportReport, String> {
    let sql = |e: rusqlite::Error| format!("The catalog couldn't be written: {e}");
    let store_root = canonical(store_root, "The folder")?;
    let marker = drives::read_marker(&store_root)?.ok_or_else(|| {
        format!(
            "{} is not an offload folder (it has no {} file).",
            store_root.display(),
            drives::MARKER
        )
    })?;
    catalog
        .upsert_store(
            &marker.id,
            &marker.label,
            &store_root.to_string_lossy(),
            &marker.created_at,
        )
        .map_err(sql)?;
    let mut report = ImportReport {
        store_id: marker.id.clone(),
        store_label: marker.label.clone(),
        ..ImportReport::default()
    };
    let host = host_name();
    let Ok(entries) = fs::read_dir(store_root.join(MANIFESTS)) else {
        return Ok(report);
    };
    let mut manifests: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    manifests.sort();
    for path in manifests {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let mut lines = text.lines();
        let Some(header) = lines
            .next()
            .and_then(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        else {
            continue;
        };
        let Ok(mut job) = serde_json::from_value::<JobRecord>(header["job"].clone()) else {
            continue;
        };
        // The drive in hand is the one these files are on, whatever the file says.
        job.store_id = marker.id.clone();
        if join_rel(&store_root, &job.rel_base).is_none() || job.rel_base.is_empty() {
            report.rows_rejected += 1;
            continue;
        }
        if !catalog.import_job(&job).map_err(sql)? {
            report.jobs_known += 1;
            continue;
        }
        report.jobs_added += 1;
        let here = job.host == host && source_reachable(Path::new(&job.source_path));
        for line in lines {
            let Ok(mut row) = serde_json::from_str::<FileRow>(line) else {
                report.rows_rejected += 1;
                continue;
            };
            let valid = row.state == "verified"
                && matches!(row.kind.as_str(), "file" | "dir" | "symlink")
                && join_rel(&store_root, &row.rel_path).is_some();
            if !valid {
                report.rows_rejected += 1;
                continue;
            }
            row.job_id = job.id.clone();
            // Whether an original is unchanged is decided here, by reading
            // it, never by what a file on the drive claims.
            row.src_stamp = None;
            row.source_removed = here
                && join_rel(Path::new(&job.source_path), &row.rel_path)
                    .is_some_and(|p| fs::symlink_metadata(p).is_err());
            catalog.record_verified(&row).map_err(sql)?;
            if row.kind != "dir" {
                report.files_added += 1;
            }
        }
        catalog.commit().map_err(sql)?;
    }
    Ok(report)
}

// ---------------------------------------------------------------------------
// What to offload
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Candidate {
    pub path: String,
    pub bytes: u64,
    pub files: u64,
    /// Days since anything in it was modified.
    pub idle_days: i64,
    /// "local": only on this computer. "copied": verified on a drive already,
    /// with the originals still here (releasing them frees the space).
    pub status: String,
    pub job_id: Option<String>,
    pub store_label: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct CandidateOptions {
    pub min_bytes: u64,
    pub min_idle_days: i64,
}

impl Default for CandidateOptions {
    fn default() -> CandidateOptions {
        CandidateOptions {
            min_bytes: 500 * 1024 * 1024,
            min_idle_days: 180,
        }
    }
}

/// Folder names that are regenerated rather than kept: delete those, don't
/// move them.
const REGENERABLE: &[&str] = &[
    "node_modules",
    "__pycache__",
    ".cache",
    "cache",
    "caches",
    ".venv",
    "venv",
    "target",
    ".next",
    ".nuxt",
    "tmp",
    "temp",
    ".git",
];
/// Folders a cloud service syncs: moving files out of them deletes them from
/// the cloud too.
const CLOUD: &[&str] = &[
    "onedrive",
    "dropbox",
    "google drive",
    "googledrive",
    "icloud drive",
    "mobile documents",
    "cloudstorage",
    "box",
    "pcloud drive",
];
/// Folders programs keep their own data in.
const APP_DATA: &[&str] = &[
    "library",
    "appdata",
    "applications",
    "program files",
    "program files (x86)",
];

fn unsuitable(path: &str, root: &str) -> bool {
    let inside = path.strip_prefix(root).unwrap_or(path);
    inside
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .any(|part| {
            let name = part.to_lowercase();
            // Hidden folders are configuration and program state.
            name.starts_with('.')
                || REGENERABLE.contains(&name.as_str())
                || APP_DATA.contains(&name.as_str())
                || CLOUD.iter().any(|c| {
                    name == *c
                        || name.starts_with(&format!("{c} "))
                        || name.starts_with(&format!("{c}-"))
                })
        })
}

/// Folders worth moving to an external drive: big, untouched for a long time,
/// and not something that should be deleted or left alone instead. Only the
/// outermost such folder is listed. `offloaded` is this computer's jobs, each
/// with whether it is fully on its drive with originals still here, and the
/// drive's label.
pub fn candidates(
    data: &ScanData,
    offloaded: &[(JobRecord, bool, String)],
    options: &CandidateOptions,
) -> Vec<Candidate> {
    let now = now_secs();
    let root = data.root.trim_end_matches(['/', '\\']);
    let mut folders: Vec<(&String, &crate::scanner::FolderStats)> = data.folders.iter().collect();
    // By path: a folder comes before everything inside it.
    folders.sort_by(|a, b| Path::new(a.0).cmp(Path::new(b.0)));
    let mut picked: Vec<Candidate> = Vec::new();
    for (path, folder) in folders {
        if path.trim_end_matches(['/', '\\']) == root
            || folder.total_size < options.min_bytes
            || folder.last_modified <= 0.0
        {
            continue;
        }
        let idle_days = ((now - folder.last_modified) / 86_400.0).floor() as i64;
        if idle_days < options.min_idle_days || unsuitable(path, root) {
            continue;
        }
        if picked.iter().any(|p| Path::new(path).starts_with(&p.path)) {
            continue;
        }
        let copied = offloaded
            .iter()
            .find(|(job, copied, _)| *copied && Path::new(path).starts_with(&job.source_path));
        picked.push(Candidate {
            path: path.clone(),
            bytes: folder.total_size,
            files: folder.file_count,
            idle_days,
            status: if copied.is_some() { "copied" } else { "local" }.into(),
            job_id: copied.map(|(job, _, _)| job.id.clone()),
            store_label: copied.map(|(_, _, label)| label.clone()),
        });
    }
    picked.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
    picked
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::FolderStats;

    #[test]
    fn catalog_paths_cannot_leave_their_folder() {
        let base = Path::new("/restore/here");
        assert_eq!(join_rel(base, ""), Some(base.to_path_buf()));
        assert_eq!(
            join_rel(base, "a/b.txt"),
            Some(base.join("a").join("b.txt"))
        );
        for bad in [
            "..",
            "../x",
            "a/../../x",
            "/etc/passwd",
            "a//b",
            "a/./b",
            "a/\0b",
            "a/",
        ] {
            assert_eq!(join_rel(base, bad), None, "{bad:?}");
        }
    }

    #[test]
    fn each_source_gets_its_own_place_on_the_drive() {
        let a = rel_base_for("laptop", Path::new("/home/me/Movies")).unwrap();
        assert_eq!(a, "laptop/home/me/Movies");
        assert_ne!(
            a,
            rel_base_for("laptop", Path::new("/home/you/Movies")).unwrap()
        );
        assert_ne!(
            a,
            rel_base_for("desktop", Path::new("/home/me/Movies")).unwrap()
        );
        assert!(join_rel(Path::new("/store"), &a).is_some());
    }

    #[test]
    fn the_host_name_is_a_safe_folder_name() {
        let host = host_name();
        assert!(
            !host.is_empty() && !host.contains(['/', '\\', ':']) && host != "." && host != ".."
        );
    }

    fn folder(path: &str, gb: u64, idle_days: f64) -> (String, FolderStats) {
        let when = now_secs() - idle_days * 86_400.0;
        (
            path.into(),
            FolderStats {
                total_size: gb * 1024 * 1024 * 1024,
                file_count: 10,
                last_modified: when,
                last_accessed: when,
            },
        )
    }

    fn scan_of(root: &str, folders: Vec<(String, FolderStats)>) -> ScanData {
        ScanData {
            root: root.into(),
            folders: folders.into_iter().collect(),
            ..ScanData::default()
        }
    }

    #[test]
    fn candidates_are_big_idle_and_not_caches_clouds_or_app_data() {
        let data = scan_of(
            "/home/me",
            vec![
                folder("/home/me", 500, 1.0),
                folder("/home/me/Movies", 100, 400.0),
                folder("/home/me/Movies/2019", 60, 900.0),
                folder("/home/me/Photos", 80, 2.0),
                folder("/home/me/Photos/2015", 30, 3000.0),
                folder("/home/me/dev/app/node_modules", 20, 700.0),
                folder("/home/me/Dropbox/old", 20, 700.0),
                folder("/home/me/OneDrive - Work/old", 20, 700.0),
                folder("/home/me/Library/Stuff", 20, 700.0),
                folder("/home/me/.config/thing", 20, 700.0),
                folder("/home/me/small", 0, 700.0),
                folder("/home/me/Boxes", 5, 700.0),
            ],
        );
        let found = candidates(&data, &[], &CandidateOptions::default());
        let paths: Vec<&str> = found.iter().map(|c| c.path.as_str()).collect();
        // Biggest first; 2019 is inside Movies, so only Movies is listed;
        // "Boxes" is not the Box sync folder.
        assert_eq!(
            paths,
            ["/home/me/Movies", "/home/me/Photos/2015", "/home/me/Boxes"]
        );
        assert!(found.iter().all(|c| c.status == "local"));
        assert!(found[0].idle_days >= 399);
    }

    #[test]
    fn a_folder_already_on_a_drive_is_marked_copied() {
        let data = scan_of(
            "/home/me/",
            vec![
                folder("/home/me", 500, 1.0),
                folder("/home/me/Movies", 100, 400.0),
                folder("/home/me/Music", 50, 400.0),
            ],
        );
        let job = |path: &str| JobRecord {
            id: format!("job-{path}"),
            store_id: "s".into(),
            host: "h".into(),
            source_path: path.into(),
            source_kind: "dir".into(),
            rel_base: "h/x".into(),
            state: "complete".into(),
            started_at: utc_now(),
            finished_at: None,
            last_checked_at: None,
            last_check_problems: None,
        };
        // An incomplete offload does not count as copied.
        let offloaded = [
            (job("/home/me/Movies"), true, "Blue".to_string()),
            (job("/home/me/Music"), false, "Blue".to_string()),
        ];
        let found = candidates(&data, &offloaded, &CandidateOptions::default());
        assert_eq!(
            (found[0].status.as_str(), found[0].store_label.as_deref()),
            ("copied", Some("Blue"))
        );
        assert_eq!(
            (found[1].status.as_str(), found[1].job_id.as_deref()),
            ("local", None)
        );
    }
}
