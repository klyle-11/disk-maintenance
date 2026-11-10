//! Shared by the offload tests: a throwaway "computer" and "drive", trees to
//! put on them, and the two audits every test ends with.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use disk_core::catalog::{Catalog, FileRow};
use disk_core::offload::{
    self, Control, Hook, NoHook, Options, Point, Progress, RemoveMode, Report, TMP_PREFIX,
};
use sha2::{Digest, Sha256};

pub struct World {
    _tmp: tempfile::TempDir,
    pub root: PathBuf,
    /// The folder being offloaded.
    pub src: PathBuf,
    /// The offload folder on the "drive".
    pub store: PathBuf,
    pub db: PathBuf,
}

/// A fresh computer and drive. They live under target/tmp rather than the
/// system temp folder, which on macOS is a system location offload refuses.
pub fn world() -> World {
    let tmp = tempfile::Builder::new()
        .prefix("offload-")
        .tempdir_in(env!("CARGO_TARGET_TMPDIR"))
        .unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    let (src, store) = (
        root.join("computer").join("Projects"),
        root.join("drive").join("Offload"),
    );
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&store).unwrap();
    World {
        db: root.join("catalog.sqlite"),
        src,
        store,
        root,
        _tmp: tmp,
    }
}

impl World {
    pub fn catalog(&self) -> Catalog {
        Catalog::open(&self.db).unwrap()
    }

    /// Where the source's copy goes on the drive.
    pub fn dest(&self) -> PathBuf {
        self.dest_of(&self.src)
    }

    pub fn dest_of(&self, source: &Path) -> PathBuf {
        offload::join_rel(
            &self.store,
            &offload::rel_base_for(&offload::host_name(), source).unwrap(),
        )
        .unwrap()
    }

    pub fn offload(&self, remove: RemoveMode, hook: &dyn Hook) -> Result<Report, String> {
        self.offload_from(&self.src, remove, hook, &AtomicBool::new(false))
    }

    pub fn offload_from(
        &self,
        source: &Path,
        remove: RemoveMode,
        hook: &dyn Hook,
        cancel: &AtomicBool,
    ) -> Result<Report, String> {
        let progress = Progress::default();
        let ctl = Control {
            progress: &progress,
            cancel,
            hook,
        };
        // The test "drive" is a folder on the same disk.
        let options = Options {
            remove,
            allow_same_volume: true,
        };
        offload::offload(&mut self.catalog(), source, &self.store, &options, &ctl)
    }

    /// The only job's id.
    pub fn job(&self) -> String {
        let jobs = self.catalog().jobs().unwrap();
        assert_eq!(jobs.len(), 1, "expected one job");
        jobs[0].job.id.clone()
    }

    /// Committed rows of the only job, by path (empty if there is no job).
    pub fn rows(&self) -> BTreeMap<String, FileRow> {
        let catalog = self.catalog();
        let jobs = catalog.jobs().unwrap();
        let Some(job) = jobs.first() else {
            return BTreeMap::new();
        };
        catalog
            .files(&job.job.id)
            .unwrap()
            .into_iter()
            .map(|r| (r.rel_path.clone(), r))
            .collect()
    }
}

pub fn with<T>(hook: &dyn Hook, run: impl FnOnce(&Control) -> T) -> T {
    let progress = Progress::default();
    let cancel = AtomicBool::new(false);
    run(&Control {
        progress: &progress,
        cancel: &cancel,
        hook,
    })
}

pub fn plain<T>(run: impl FnOnce(&Control) -> T) -> T {
    with(&NoHook, run)
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

pub fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

/// Repeatable pseudo-random bytes.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    pub fn bytes(&mut self, len: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(len + 8);
        while out.len() < len {
            out.extend_from_slice(&self.next().to_le_bytes());
        }
        out.truncate(len);
        out
    }
}

/// A small tree with the awkward cases in it: an empty file, a file bigger
/// than one copy chunk, deep folders, an empty folder, odd names, links.
pub fn plant(src: &Path) {
    let mut rng = Rng(0x5eed_1234_abcd_ef01);
    write(&src.join("a.txt"), b"alpha");
    write(&src.join("empty.bin"), b"");
    write(&src.join("big.bin"), &rng.bytes(2 * 1024 * 1024 + 4321));
    write(&src.join("docs/notes.md"), b"# notes\n");
    write(&src.join("docs/deep/er/file.dat"), &rng.bytes(70_000));
    fs::create_dir_all(src.join("docs/empty-dir")).unwrap();
    write(
        &src.join("photos/\u{fc}\u{f1}\u{ed} \u{e7}\u{f8}d\u{e9}.jpg"),
        &rng.bytes(9000),
    );
    write(
        &src.join("photos/with space & 'quotes'.png"),
        &rng.bytes(300),
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::os::unix::fs::symlink("a.txt", src.join("link-to-a")).unwrap();
        std::os::unix::fs::symlink("nowhere/at/all", src.join("docs/dangling")).unwrap();
        fs::set_permissions(src.join("a.txt"), fs::Permissions::from_mode(0o640)).unwrap();
    }
    let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_500_000_000);
    fs::File::options()
        .write(true)
        .open(src.join("a.txt"))
        .unwrap()
        .set_modified(old)
        .unwrap();
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Dir,
    File { sha: String, len: u64 },
    Link(String),
    Other,
}

pub type Snap = BTreeMap<String, Item>;

pub fn sha_of(path: &Path) -> String {
    let mut file = fs::File::open(path).unwrap();
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Everything under `root` (not following links): what it is and, for files,
/// what is in it. Empty if `root` is not there.
pub fn snap(root: &Path) -> Snap {
    let mut out = Snap::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel_dir)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if rel_dir.is_empty() {
                name
            } else {
                format!("{rel_dir}/{name}")
            };
            let kind = entry.file_type().unwrap();
            let item = if kind.is_dir() {
                stack.push((entry.path(), rel.clone()));
                Item::Dir
            } else if kind.is_symlink() {
                Item::Link(
                    fs::read_link(entry.path())
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                )
            } else if kind.is_file() {
                Item::File {
                    sha: sha_of(&entry.path()),
                    len: entry.metadata().unwrap().len(),
                }
            } else {
                Item::Other
            };
            out.insert(rel, item);
        }
    }
    out
}

pub fn files_in(snap: &Snap) -> usize {
    snap.values().filter(|i| !matches!(i, Item::Dir)).count()
}

pub fn has_leftovers(root: &Path) -> bool {
    snap(root)
        .keys()
        .any(|rel| rel.rsplit('/').next().unwrap().starts_with(TMP_PREFIX))
}

// ---------------------------------------------------------------------------
// The audits
// ---------------------------------------------------------------------------

/// THE invariant. Every file and link that existed before the run is still
/// whole in at least one place: where it was, or on the drive with a committed
/// catalog row that carries its checksum.
pub fn assert_nothing_lost(w: &World, before: &Snap) {
    let (at_source, on_drive, rows) = (snap(&w.src), snap(&w.dest()), w.rows());
    for (rel, item) in before {
        if matches!(item, Item::Dir) {
            continue;
        }
        let here = at_source.get(rel) == Some(item);
        let there = on_drive.get(rel) == Some(item);
        let recorded = rows.get(rel).is_some_and(|row| {
            row.state == "verified"
                && match item {
                    Item::File { sha, len } => {
                        row.sha256.as_deref() == Some(sha) && row.size as u64 == *len
                    }
                    Item::Link(target) => row.link_target.as_deref() == Some(target),
                    _ => false,
                }
        });
        assert!(
            here || (there && recorded),
            "LOST: {rel}\n  at source: {:?}\n  on drive: {:?}\n  catalog: {:?}\n  was: {item:?}",
            at_source.get(rel),
            on_drive.get(rel),
            rows.get(rel).map(|r| (&r.state, &r.sha256)),
        );
    }
}

/// The catalog claims nothing that isn't so: every row marked verified is on
/// the drive with exactly that content, and `source_removed` matches whether
/// the original is on the computer.
pub fn assert_catalog_true(w: &World) {
    let (on_drive, dest) = (snap(&w.dest()), w.dest());
    for (rel, row) in w.rows() {
        if row.state != "verified" {
            continue;
        }
        if rel.is_empty() {
            assert!(
                dest.is_dir() || dest.is_file(),
                "the catalog says the source's copy exists"
            );
            continue;
        }
        match (row.kind.as_str(), on_drive.get(&rel)) {
            ("dir", Some(Item::Dir)) => continue,
            ("file", Some(Item::File { sha, len })) => {
                assert_eq!(
                    (row.sha256.as_deref(), row.size as u64),
                    (Some(sha.as_str()), *len),
                    "catalog and drive disagree on {rel}"
                )
            }
            ("symlink", Some(Item::Link(target))) => {
                assert_eq!(row.link_target.as_deref(), Some(target.as_str()))
            }
            (kind, found) => panic!(
                "the catalog says {rel} ({kind}) is verified on the drive, but there is {found:?}"
            ),
        }
        let original_gone = fs::symlink_metadata(w.src.join(&rel)).is_err();
        assert_eq!(
            row.source_removed, original_gone,
            "source_removed is wrong for {rel}"
        );
    }
}

/// The report's numbers add up and match the disk. `before` is the source as
/// it was when the run started.
pub fn assert_report_true(w: &World, before: &Snap, report: &Report) {
    assert_eq!(
        report.items_seen,
        report.verified_files + report.failed + report.skipped,
        "every item is counted exactly once: {report:#?}"
    );
    assert_eq!(
        report.verified_files,
        report.copied_files + report.already_files
    );
    assert_eq!(
        report.verified_bytes,
        report.copied_bytes + report.already_bytes
    );
    let now = snap(&w.src);
    let gone = before
        .iter()
        .filter(|(rel, item)| !matches!(item, Item::Dir) && !now.contains_key(*rel))
        .count() as u64;
    assert_eq!(
        report.removal.removed_files, gone,
        "removed_files must be the originals that are actually gone: {report:#?}"
    );
    let removal = &report.removal;
    if !removal.trashed {
        assert_eq!(
            removal.checked,
            removal.removed_files + removal.kept_files + removal.already_gone,
            "{removal:#?}"
        );
    }
    if report.outcome == "complete" {
        assert_eq!(
            (
                report.failed,
                report.skipped,
                removal.kept_files,
                &report.stopped
            ),
            (0, 0, 0, &None)
        );
        assert_eq!(
            report.verified_files as usize,
            files_in(before),
            "complete means everything that was there"
        );
    }
    assert!(report.problems_total >= report.failed + report.skipped);
    assert!(report.problems.len() as u64 <= report.problems_total);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/// Run a closure at every hook point.
pub struct On<F: Fn(Point, &Path) -> io::Result<()> + Sync>(pub F);

impl<F: Fn(Point, &Path) -> io::Result<()> + Sync> Hook for On<F> {
    fn at(&self, point: Point, path: &Path) -> io::Result<()> {
        (self.0)(point, path)
    }
}

/// Counts hook calls, and fails (or crashes) the `n`th.
pub struct FailNth {
    pub calls: AtomicUsize,
    pub n: usize,
    pub crash: bool,
    pub seen: Mutex<Vec<Point>>,
}

impl FailNth {
    pub fn counting() -> FailNth {
        FailNth {
            calls: AtomicUsize::new(0),
            n: usize::MAX,
            crash: false,
            seen: Mutex::new(Vec::new()),
        }
    }
    pub fn at(n: usize, crash: bool) -> FailNth {
        FailNth {
            n,
            crash,
            ..FailNth::counting()
        }
    }
}

impl Hook for FailNth {
    fn at(&self, point: Point, _path: &Path) -> io::Result<()> {
        self.seen.lock().unwrap().push(point);
        if self.calls.fetch_add(1, Ordering::SeqCst) == self.n {
            return Err(if self.crash {
                offload::crash()
            } else {
                io::Error::other("injected failure")
            });
        }
        Ok(())
    }
}

/// A stand-in Trash: a folder things are moved into.
pub struct Bin(pub PathBuf);

impl Hook for Bin {
    fn trash(&self, path: &Path) -> Option<io::Result<()>> {
        fs::create_dir_all(&self.0).unwrap();
        Some(fs::rename(path, self.0.join(path.file_name().unwrap())))
    }
}

/// Flip one byte in the middle of a file, keeping its size.
pub fn corrupt(path: &Path) {
    let mut bytes = fs::read(path).unwrap();
    assert!(!bytes.is_empty(), "can't corrupt an empty file");
    let at = bytes.len() / 2;
    bytes[at] ^= 0x01;
    fs::write(path, bytes).unwrap();
}

pub fn is_root() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: no arguments, no side effects.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(unix))]
    false
}
