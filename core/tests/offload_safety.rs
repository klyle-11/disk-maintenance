//! Offload must never be the reason a file is lost, and must never say
//! something that isn't so. Each test breaks a run in a different way and
//! then audits the disk and the catalog (see `common`).

mod common;

use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use common::*;
use disk_core::drives;
use disk_core::offload::{
    self, crash, Control, Hook, NoHook, Options, Point, Progress, RemoveMode, CRASHED, TMP_PREFIX,
};

// ---------------------------------------------------------------------------
// When nothing goes wrong
// ---------------------------------------------------------------------------

#[test]
fn keep_copies_everything_and_touches_no_original() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);

    let report = w.offload(RemoveMode::Keep, &NoHook).unwrap();

    assert_eq!(report.outcome, "complete");
    assert_eq!(
        snap(&w.src),
        before,
        "the originals are exactly as they were"
    );
    assert_eq!(
        snap(&w.dest()),
        before,
        "the drive holds the same tree: files, links and empty folders"
    );
    assert_eq!(report.copied_files as usize, files_in(&before));
    assert_eq!(report.already_files, 0);
    assert_eq!(report.removal, offload::Removal::default());
    assert!(!has_leftovers(&w.store));
    assert_nothing_lost(&w, &before);
    assert_catalog_true(&w);
    assert_report_true(&w, &before, &report);

    // The drive describes itself.
    let manifest = fs::read_to_string(
        w.store
            .join(drives::MANIFESTS)
            .join(format!("{}.jsonl", report.job_id)),
    )
    .unwrap();
    assert!(manifest.lines().count() > files_in(&before));
    assert!(manifest.contains("big.bin") && manifest.contains(&report.job_id));
    assert!(drives::read_marker(&w.store)
        .unwrap()
        .is_some_and(|m| m.id == report.store_id));
}

#[test]
fn times_and_permissions_survive_the_trip() {
    let w = world();
    plant(&w.src);
    w.offload(RemoveMode::Keep, &NoHook).unwrap();
    let (original, copy) = (
        fs::metadata(w.src.join("a.txt")).unwrap(),
        fs::metadata(w.dest().join("a.txt")).unwrap(),
    );
    assert_eq!(original.modified().unwrap(), copy.modified().unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(copy.permissions().mode() & 0o777, 0o640);
    }
}

#[test]
fn delete_removes_only_after_everything_checks_out() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);

    let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();

    assert_eq!(report.outcome, "complete");
    assert!(!w.src.exists(), "the emptied folder itself is removed");
    assert_eq!(snap(&w.dest()), before);
    assert_eq!(report.removal.removed_files as usize, files_in(&before));
    assert_eq!(
        (report.removal.kept_files, report.removal.folders_left),
        (0, 0)
    );
    assert!(
        report.removal.freed_bytes >= 2 * 1024 * 1024,
        "at least the big file's blocks came back"
    );
    assert_nothing_lost(&w, &before);
    assert_catalog_true(&w);
    assert_report_true(&w, &before, &report);
    let summary = &w.catalog().jobs().unwrap()[0];
    assert_eq!(
        (
            summary.job.state.as_str(),
            summary.verified_files,
            summary.removed_files
        ),
        (
            "complete",
            files_in(&before) as i64,
            files_in(&before) as i64
        )
    );
}

#[test]
fn trash_moves_the_whole_folder_at_once() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let bin = Bin(w.root.join("trash"));

    let report = w.offload(RemoveMode::Trash, &bin).unwrap();

    assert_eq!(report.outcome, "complete");
    assert!(report.removal.trashed);
    assert!(!w.src.exists());
    assert_eq!(
        snap(&bin.0.join("Projects")),
        before,
        "the Trash has the folder, whole"
    );
    assert_eq!(
        report.removal.freed_bytes, 0,
        "nothing is freed until the Trash is emptied"
    );
    assert_nothing_lost(&w, &before);
    assert_catalog_true(&w);
    assert_report_true(&w, &before, &report);
}

#[test]
fn trash_is_all_or_nothing() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    // One file can't be copied...
    struct OneFails(Bin);
    impl Hook for OneFails {
        fn at(&self, point: Point, path: &Path) -> io::Result<()> {
            if point == Point::FileStart && path.ends_with("notes.md") {
                return Err(io::Error::other("injected"));
            }
            Ok(())
        }
        fn trash(&self, path: &Path) -> Option<io::Result<()>> {
            self.0.trash(path)
        }
    }
    let hook = OneFails(Bin(w.root.join("trash")));

    let report = w.offload(RemoveMode::Trash, &hook).unwrap();

    // ...so the folder stays, every file of it.
    assert_eq!(report.outcome, "incomplete");
    assert_eq!(snap(&w.src), before);
    assert!(!report.removal.trashed);
    assert_eq!(report.removal.removed_files, 0);
    assert!(!hook.0 .0.exists(), "nothing went to the Trash");
    assert!(report
        .problems
        .iter()
        .any(|p| p.kind == "kept" && p.message.contains("nothing was moved to the Trash")));
    assert_catalog_true(&w);
    assert_report_true(&w, &before, &report);
}

#[test]
fn trash_refuses_when_a_file_arrived_after_the_copy() {
    let w = world();
    plant(&w.src);
    w.offload(RemoveMode::Keep, &NoHook).unwrap();
    // A new file lands in the folder between the copy and the release.
    write(&w.src.join("docs/new-since.txt"), b"not on the drive");
    let bin = Bin(w.root.join("trash"));

    let report = with(&bin, |ctl| {
        offload::release(&mut w.catalog(), &w.job(), RemoveMode::Trash, ctl)
    })
    .unwrap();

    assert_eq!(report.outcome, "incomplete");
    assert!(w.src.join("docs/new-since.txt").exists() && w.src.join("a.txt").exists());
    assert!(report
        .problems
        .iter()
        .any(|p| p.path == "docs/new-since.txt" && p.message.contains("not on the drive")));
}

#[test]
fn trash_checks_every_file_before_the_folder_goes() {
    // Keep first, then two things go wrong before the release: a copy rots on
    // the drive, and an original is edited. Either alone must stop the Trash.
    for damage in ["copy", "original"] {
        let w = world();
        plant(&w.src);
        w.offload(RemoveMode::Keep, &NoHook).unwrap();
        if damage == "copy" {
            corrupt(&w.dest().join("docs/deep/er/file.dat"));
        } else {
            fs::write(w.src.join("docs/notes.md"), b"# notes, edited since\n").unwrap();
        }
        let before = snap(&w.src);
        let bin = Bin(w.root.join("trash"));

        let report = with(&bin, |ctl| {
            offload::release(&mut w.catalog(), &w.job(), RemoveMode::Trash, ctl)
        })
        .unwrap();

        assert_eq!(report.outcome, "incomplete", "{damage}");
        assert!(!report.removal.trashed && !bin.0.exists(), "{damage}");
        assert_eq!(snap(&w.src), before, "{damage}: the folder is untouched");
        assert_eq!(report.removal.removed_files, 0);
    }
}

#[test]
fn trash_in_the_same_run_rereads_the_copies_first() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let dest = w.dest();
    struct RotThenBin(std::path::PathBuf, Bin);
    impl Hook for RotThenBin {
        fn at(&self, point: Point, _: &Path) -> io::Result<()> {
            // All copied and listed; then one copy goes bad.
            if point == Point::Manifest {
                corrupt(&self.0.join("big.bin"));
            }
            Ok(())
        }
        fn trash(&self, path: &Path) -> Option<io::Result<()>> {
            self.1.trash(path)
        }
    }
    let hook = RotThenBin(dest, Bin(w.root.join("trash")));

    let report = w.offload(RemoveMode::Trash, &hook).unwrap();

    assert_eq!(report.outcome, "incomplete");
    assert!(!report.removal.trashed);
    assert_eq!(snap(&w.src), before);
    assert_eq!(w.rows()["big.bin"].drive_state.as_deref(), Some("damaged"));
}

#[test]
fn a_single_file_can_be_offloaded_and_brought_back() {
    let w = world();
    let file = w.src.join("movie.mkv");
    let bytes = Rng(7).bytes(1_300_000);
    write(&file, &bytes);

    let report = w
        .offload_from(&file, RemoveMode::Delete, &NoHook, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        (
            report.outcome.as_str(),
            report.copied_files,
            report.removal.removed_files
        ),
        ("complete", 1, 1)
    );
    assert!(!file.exists());
    assert_eq!(fs::read(w.dest_of(&file)).unwrap(), bytes);
    assert!(
        w.src.exists(),
        "the folder the file was in is not the job's to remove"
    );

    let back =
        plain(|ctl| offload::restore(&mut w.catalog(), &report.job_id, None, None, ctl)).unwrap();
    assert_eq!(
        (back.outcome.as_str(), back.restored_files),
        ("complete", 1)
    );
    assert_eq!(fs::read(&file).unwrap(), bytes);
}

// ---------------------------------------------------------------------------
// The copy goes wrong
// ---------------------------------------------------------------------------

/// The drive stores something other than what was written. The read-back
/// must catch it, whatever the damage looks like.
fn damaged_on_the_way(damage: fn(&Path)) {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let hook = On(move |point, path: &Path| {
        // `path` is the temporary copy; the name of the original isn't in it,
        // so pick the one with big.bin's size.
        if point == Point::Written && fs::metadata(path).unwrap().len() == 2 * 1024 * 1024 + 4321 {
            damage(path);
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!((report.outcome.as_str(), report.failed), ("incomplete", 1));
    assert!(
        w.src.join("big.bin").exists(),
        "the original of the bad copy stays"
    );
    assert_eq!(snap(&w.src).get("big.bin"), before.get("big.bin"));
    assert!(
        !w.dest().join("big.bin").exists(),
        "the bad copy never gets the real name"
    );
    assert!(!has_leftovers(&w.store), "the bad copy is discarded");
    assert!(report
        .problems
        .iter()
        .any(|p| p.path == "big.bin" && p.message.contains("did not read back")));
    assert!(
        !w.src.join("a.txt").exists(),
        "the good copies' originals still go"
    );
    assert_eq!(w.rows()["big.bin"].state, "failed");
    assert_nothing_lost(&w, &before);
    assert_catalog_true(&w);
    assert_report_true(&w, &before, &report);

    // The next run copies it properly.
    let again = w.offload(RemoveMode::Delete, &NoHook).unwrap();
    assert_eq!(
        (again.outcome.as_str(), again.copied_files),
        ("complete", 1)
    );
    assert_eq!(snap(&w.dest()), before);
    assert_nothing_lost(&w, &before);
}

#[test]
fn a_flipped_bit_on_the_drive_is_caught() {
    damaged_on_the_way(corrupt);
}

#[test]
fn a_truncated_copy_is_caught() {
    damaged_on_the_way(|path| {
        let len = fs::metadata(path).unwrap().len();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_len(len - 1)
            .unwrap();
    });
}

#[test]
fn a_copy_that_reads_back_as_zeroes_is_caught() {
    damaged_on_the_way(|path| {
        let len = fs::metadata(path).unwrap().len() as usize;
        fs::write(path, vec![0u8; len]).unwrap();
    });
}

#[test]
fn a_copy_that_goes_bad_before_removal_keeps_its_original() {
    // Verified, named, recorded... and then the drive corrupts it. The second
    // read, just before the original is removed, has to notice.
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let dest = w.dest();
    let hook = On(move |point, path: &Path| {
        if point == Point::BeforeRemove && path.ends_with("file.dat") {
            corrupt(&dest.join("docs/deep/er/file.dat"));
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!(
        snap(&w.src).get("docs/deep/er/file.dat"),
        before.get("docs/deep/er/file.dat"),
        "the original is still here, intact"
    );
    assert_eq!(report.removal.kept_files, 1);
    assert_eq!(
        report.removal.folders_left, 4,
        "its folders stay too: er, deep, docs and the root"
    );
    assert!(report
        .problems
        .iter()
        .any(|p| p.kind == "kept" && p.message.contains("damaged")));
    assert_eq!(
        w.rows()["docs/deep/er/file.dat"].drive_state.as_deref(),
        Some("damaged")
    );
    assert_nothing_lost(&w, &before);
    assert_report_true(&w, &before, &report);
}

#[test]
fn a_copy_that_vanishes_before_removal_keeps_its_original() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let dest = w.dest();
    let hook = On(move |point, path: &Path| {
        if point == Point::BeforeRemove && path.ends_with("a.txt") {
            fs::remove_file(dest.join("a.txt")).unwrap();
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!(fs::read(w.src.join("a.txt")).unwrap(), b"alpha");
    assert_eq!(report.removal.kept_files, 1);
    assert_eq!(w.rows()["a.txt"].drive_state.as_deref(), Some("missing"));
    assert_nothing_lost(&w, &before);
    assert_report_true(&w, &before, &report);
}

// ---------------------------------------------------------------------------
// The original changes under the run
// ---------------------------------------------------------------------------

#[test]
fn a_file_that_changes_while_being_copied_is_not_taken() {
    let w = world();
    plant(&w.src);
    let source = w.src.join("big.bin");
    let once = AtomicBool::new(false);
    let hook = On(|point, path: &Path| {
        // In the middle of the big file's copy, something appends to it.
        if point == Point::Chunk
            && fs::metadata(path).unwrap().len() >= 1024 * 1024
            && !once.swap(true, Ordering::SeqCst)
        {
            use std::io::Write;
            fs::File::options()
                .append(true)
                .open(&source)
                .unwrap()
                .write_all(b"more")
                .unwrap();
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert!(once.load(Ordering::SeqCst));
    assert_eq!(report.failed, 1);
    assert!(report
        .problems
        .iter()
        .any(|p| p.path == "big.bin" && p.message.contains("changed while")));
    assert_eq!(
        fs::metadata(&source).unwrap().len(),
        2 * 1024 * 1024 + 4321 + 4,
        "the changed original is untouched"
    );
    assert!(
        !w.dest().join("big.bin").exists(),
        "no half-old, half-new copy is kept"
    );
    assert!(!has_leftovers(&w.store));
    assert_catalog_true(&w);
}

#[test]
fn a_file_that_appears_on_the_drive_mid_copy_is_not_overwritten() {
    let w = world();
    plant(&w.src);
    let once = AtomicBool::new(false);
    let hook = On(|point, path: &Path| {
        // Just before the verified copy gets its real name, something else
        // puts a file there.
        if point == Point::Rename && path.ends_with("a.txt") && !once.swap(true, Ordering::SeqCst) {
            fs::write(path, b"someone else's file").unwrap();
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert!(once.load(Ordering::SeqCst));
    assert_eq!(
        fs::read(w.dest().join("a.txt")).unwrap(),
        b"someone else's file",
        "the other file is untouched"
    );
    assert_eq!(
        fs::read(w.src.join("a.txt")).unwrap(),
        b"alpha",
        "the original stays, since its copy isn't on the drive"
    );
    assert_eq!(report.failed, 1);
    assert_eq!(report.outcome, "incomplete");
    assert!(report
        .problems
        .iter()
        .any(|p| p.path == "a.txt" && p.message.contains("not overwritten")));
    assert!(!has_leftovers(&w.store));
    assert_catalog_true(&w);
}

/// The crash tests only mean something if a crash loses what a real one
/// would: records not yet committed. (The files themselves are on the drive.)
#[test]
fn a_simulated_crash_loses_uncommitted_records_like_a_real_one() {
    let w = world();
    plant(&w.src);
    let files = AtomicUsize::new(0);
    let hook = On(|point, _: &Path| {
        // Crash once the third file has been recorded.
        if point == Point::Recorded && files.fetch_add(1, Ordering::SeqCst) == 2 {
            return Err(offload::crash());
        }
        Ok(())
    });

    let crashed = w.offload(RemoveMode::Keep, &hook);

    assert!(crashed.is_err());
    assert!(
        w.rows()
            .values()
            .all(|row| row.kind == "dir" || row.state != "verified"),
        "nothing from the open batch may survive a crash"
    );
    // And the next run finds the copies already on the drive and finishes.
    let report = w.offload(RemoveMode::Keep, &NoHook).unwrap();
    assert_eq!(report.outcome, "complete");
    assert!(report.already_files >= 3);
    assert_catalog_true(&w);
}

#[test]
fn a_file_edited_after_its_copy_is_not_deleted() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let hook = On(|point, path: &Path| {
        if point == Point::BeforeRemove && path.ends_with("notes.md") {
            fs::write(path, b"# notes, edited since\n").unwrap();
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!(
        fs::read(w.src.join("docs/notes.md")).unwrap(),
        b"# notes, edited since\n",
        "the newer version survives"
    );
    assert_eq!(
        fs::read(w.dest().join("docs/notes.md")).unwrap(),
        b"# notes\n",
        "the drive has the version that was copied"
    );
    assert_eq!(report.removal.kept_files, 1);
    assert!(report
        .problems
        .iter()
        .any(|p| p.kind == "kept" && p.message.contains("changed after it was copied")));
    assert_catalog_true(&w);
    assert_report_true(&w, &before, &report);
}

#[test]
fn an_edit_that_keeps_size_and_time_is_still_noticed() {
    // Same length, modification time put back: only the contents differ.
    let w = world();
    plant(&w.src);
    let hook = On(|point, path: &Path| {
        if point == Point::BeforeRemove && path.ends_with("a.txt") {
            let time = fs::metadata(path).unwrap().modified().unwrap();
            fs::write(path, b"ALPHA").unwrap();
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(time)
                .unwrap();
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!(fs::read(w.src.join("a.txt")).unwrap(), b"ALPHA");
    assert_eq!(report.removal.kept_files, 1);
}

#[test]
fn a_file_replaced_by_a_folder_is_left_alone() {
    let w = world();
    plant(&w.src);
    let hook = On(|point, path: &Path| {
        if point == Point::BeforeRemove && path.ends_with("a.txt") {
            fs::remove_file(path).unwrap();
            fs::create_dir(path).unwrap();
            fs::write(path.join("inside.txt"), b"new work").unwrap();
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!(
        fs::read(w.src.join("a.txt/inside.txt")).unwrap(),
        b"new work"
    );
    assert_eq!(report.removal.kept_files, 1);
}

#[test]
fn files_added_during_the_run_stay_and_keep_their_folders() {
    let w = world();
    plant(&w.src);
    let added = w.src.join("docs/deep/added-late.txt");
    let once = AtomicBool::new(false);
    let hook = On(|point, _: &Path| {
        if point == Point::Manifest && !once.swap(true, Ordering::SeqCst) {
            fs::write(&added, b"written after the copy pass").unwrap();
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!(fs::read(&added).unwrap(), b"written after the copy pass");
    assert!(!w.src.join("a.txt").exists());
    assert!(
        report.removal.folders_left >= 3,
        "docs/deep, docs and the root are not empty, so they stay"
    );
    assert_catalog_true(&w);
}

// ---------------------------------------------------------------------------
// What is already on the drive
// ---------------------------------------------------------------------------

#[test]
fn a_different_file_on_the_drive_is_never_overwritten() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    // Same name, same size, different contents: the hardest case to tell.
    write(&w.dest().join("a.txt"), b"ALPHA");
    write(&w.dest().join("docs/notes.md"), b"something else entirely");

    let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();

    assert_eq!(
        fs::read(w.dest().join("a.txt")).unwrap(),
        b"ALPHA",
        "what was on the drive is untouched"
    );
    assert_eq!(
        fs::read(w.dest().join("docs/notes.md")).unwrap(),
        b"something else entirely"
    );
    assert_eq!(
        fs::read(w.src.join("a.txt")).unwrap(),
        b"alpha",
        "and so are the originals"
    );
    assert!(w.src.join("docs/notes.md").exists());
    assert_eq!((report.outcome.as_str(), report.failed), ("incomplete", 2));
    assert!(
        report
            .problems
            .iter()
            .filter(|p| p.message.contains("not overwritten"))
            .count()
            == 2
    );
    assert_nothing_lost(&w, &before);
    assert_catalog_true(&w);
    assert_report_true(&w, &before, &report);
}

#[test]
fn a_second_run_recognises_what_is_there_by_content_and_rewrites_nothing() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    w.offload(RemoveMode::Keep, &NoHook).unwrap();
    let written = fs::metadata(w.dest().join("big.bin")).unwrap();

    let writes = AtomicUsize::new(0);
    let hook = On(|point, _: &Path| {
        if point == Point::Chunk {
            writes.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    });
    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!(writes.load(Ordering::SeqCst), 0, "nothing is written twice");
    assert_eq!(
        (
            report.outcome.as_str(),
            report.copied_files,
            report.already_files as usize
        ),
        ("complete", 0, files_in(&before))
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            fs::metadata(w.dest().join("big.bin")).unwrap().ino(),
            written.ino()
        );
    }
    let _ = written;
    assert!(!w.src.exists());
    assert_nothing_lost(&w, &before);
    assert_report_true(&w, &before, &report);
}

#[test]
fn offloading_again_later_keeps_the_record_of_what_went_before() {
    let w = world();
    plant(&w.src);
    let first = snap(&w.src);
    w.offload(RemoveMode::Delete, &NoHook).unwrap();
    // Months later the folder is back in use with new files in it.
    write(&w.src.join("docs/2027-report.md"), b"new");
    write(&w.src.join("a.txt"), b"a different a.txt this time");

    let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();

    assert_eq!(
        fs::read(w.dest().join("docs/2027-report.md")).unwrap(),
        b"new"
    );
    assert_eq!(report.copied_files, 1);
    // The new a.txt can't replace the one on the drive: both are kept.
    assert_eq!(fs::read(w.dest().join("a.txt")).unwrap(), b"alpha");
    assert_eq!(
        fs::read(w.src.join("a.txt")).unwrap(),
        b"a different a.txt this time"
    );
    assert_eq!(report.failed, 1);
    let rows = w.rows();
    assert_eq!(
        rows["a.txt"].state, "verified",
        "the earlier copy is still on record, with its checksum"
    );
    assert_eq!(rows["big.bin"].state, "verified");
    assert_eq!(snap(&w.dest()).get("big.bin"), first.get("big.bin"));
    assert_eq!(w.catalog().search("big.bin", 10).unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// Stopping part-way
// ---------------------------------------------------------------------------

#[test]
fn cancelling_removes_nothing_and_leaves_no_partial_file() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let cancel = AtomicBool::new(false);
    let hook = On(|point, _: &Path| {
        if point == Point::Chunk {
            cancel.store(true, Ordering::SeqCst);
        }
        Ok(())
    });

    let report = w
        .offload_from(&w.src, RemoveMode::Delete, &hook, &cancel)
        .unwrap();

    assert_eq!(report.outcome, "cancelled");
    assert_eq!(
        snap(&w.src),
        before,
        "a cancelled run removes nothing, even in delete mode"
    );
    assert_eq!(report.removal, offload::Removal::default());
    assert!(!has_leftovers(&w.store));
    assert_eq!(w.catalog().jobs().unwrap()[0].job.state, "incomplete");
    assert_catalog_true(&w);

    // Carrying on finishes the job.
    let again = w.offload(RemoveMode::Delete, &NoHook).unwrap();
    assert_eq!(again.outcome, "complete");
    assert_eq!(snap(&w.dest()), before);
    assert!(!w.src.exists());
}

#[test]
fn cancelling_during_removal_reports_exactly_what_went() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let cancel = AtomicBool::new(false);
    let removed = AtomicUsize::new(0);
    let hook = On(|point, _: &Path| {
        if point == Point::Removed && removed.fetch_add(1, Ordering::SeqCst) == 2 {
            cancel.store(true, Ordering::SeqCst);
        }
        Ok(())
    });

    let report = w
        .offload_from(&w.src, RemoveMode::Delete, &hook, &cancel)
        .unwrap();

    assert_eq!(report.outcome, "cancelled");
    assert_eq!(report.removal.removed_files, 3);
    assert_nothing_lost(&w, &before);
    assert_catalog_true(&w);
    assert_report_true(&w, &before, &report);
}

/// The points a clean delete-mode run of the planted tree passes through.
fn points_of_a_clean_run() -> Vec<Point> {
    let w = world();
    plant(&w.src);
    let hook = FailNth::counting();
    assert_eq!(
        w.offload(RemoveMode::Delete, &hook).unwrap().outcome,
        "complete"
    );
    hook.seen.into_inner().unwrap()
}

#[test]
fn a_crash_at_any_point_loses_nothing_and_the_next_run_finishes() {
    let points = points_of_a_clean_run();
    // Every kind of point is in there, so every kind of crash is tried.
    for point in [
        Point::FileStart,
        Point::Chunk,
        Point::Written,
        Point::ReadBack,
        Point::Rename,
        Point::Renamed,
        Point::Recorded,
        Point::Manifest,
        Point::BeforeRemove,
        Point::Removed,
        Point::RemoveDir,
    ] {
        assert!(points.contains(&point), "{point:?} is never reached");
    }
    for (n, point) in points.iter().enumerate() {
        let w = world();
        plant(&w.src);
        let before = snap(&w.src);

        let crashed = w.offload(RemoveMode::Delete, &FailNth::at(n, true));

        assert_eq!(
            crashed.err().as_deref(),
            Some(CRASHED),
            "call {n} ({point:?})"
        );
        // Whatever state that left, no file is gone without a verified,
        // committed copy.
        assert_nothing_lost(&w, &before);
        // The app's next start puts the record straight, before any rerun.
        assert_eq!(
            offload::recover(&mut w.catalog()).unwrap(),
            1,
            "call {n} ({point:?})"
        );
        assert_catalog_true(&w);
        assert_eq!(w.catalog().jobs().unwrap()[0].job.state, "incomplete");

        // The same command again picks up where it stopped.
        let report = w
            .offload(RemoveMode::Delete, &NoHook)
            .unwrap_or_else(|e| panic!("resume after crash at call {n} ({point:?}): {e}"));
        assert_eq!(
            report.outcome, "complete",
            "after crash at call {n} ({point:?}): {report:#?}"
        );
        assert_eq!(
            snap(&w.dest()),
            before,
            "after crash at call {n} ({point:?})"
        );
        assert!(!w.src.exists(), "after crash at call {n} ({point:?})");
        assert!(
            !has_leftovers(&w.store),
            "the interrupted copy's leftover is cleared (call {n}, {point:?})"
        );
        assert_nothing_lost(&w, &before);
        assert_catalog_true(&w);
        assert_eq!(
            report.removal.removed_files + report.removal.already_gone,
            files_in(&before) as u64
        );
    }
}

#[test]
fn a_crash_while_keeping_originals_changes_nothing_on_the_computer() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let hook = FailNth::counting();
    w.offload(RemoveMode::Keep, &hook).unwrap();
    let total = hook.calls.load(Ordering::SeqCst);
    for n in 0..total {
        let w = world();
        plant(&w.src);
        assert!(w.offload(RemoveMode::Keep, &FailNth::at(n, true)).is_err());
        assert_eq!(snap(&w.src), before, "crash at call {n}");
        assert_catalog_true(&w);
    }
}

#[test]
fn a_failure_at_any_point_loses_nothing_and_is_reported_truthfully() {
    let points = points_of_a_clean_run();
    for (n, point) in points.iter().enumerate() {
        let w = world();
        plant(&w.src);
        let before = snap(&w.src);

        let report = w
            .offload(RemoveMode::Delete, &FailNth::at(n, false))
            .unwrap_or_else(|e| panic!("call {n} ({point:?}): {e}"));

        assert_nothing_lost(&w, &before);
        assert_catalog_true(&w);
        assert_report_true(&w, &before, &report);
        assert!(!has_leftovers(&w.store), "call {n} ({point:?})");
        assert_ne!(
            report.outcome, "complete",
            "call {n} ({point:?}) failed, so the run must not say complete: {report:#?}"
        );

        let again = w.offload(RemoveMode::Delete, &NoHook).unwrap();
        assert_eq!(
            again.outcome, "complete",
            "rerun after failure at call {n} ({point:?}): {again:#?}"
        );
        assert_eq!(snap(&w.dest()), before);
        assert!(!w.src.exists());
        assert_catalog_true(&w);
    }
}

#[test]
fn a_full_drive_stops_the_run_with_every_original_in_place() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let hook = On(|point, path: &Path| {
        if point == Point::Chunk && fs::metadata(path).unwrap().len() > 1024 * 1024 {
            return Err(offload::disk_full());
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!(report.stopped.as_deref(), Some("the drive is full"));
    assert_eq!(report.outcome, "incomplete");
    assert_eq!(
        snap(&w.src),
        before,
        "a run that stopped early removes nothing"
    );
    assert_eq!(report.removal, offload::Removal::default());
    assert!(
        !has_leftovers(&w.store),
        "the half-written file is discarded"
    );
    assert!(
        report.items_seen < files_in(&before) as u64,
        "it stopped instead of failing every remaining file"
    );
    assert_catalog_true(&w);
    assert_report_true(&w, &before, &report);
}

/// The same, against a drive that really fills up, so the system's own
/// "no space" error is the one recognised. Needs a small scratch disk:
///
/// ```sh
/// mkdir /tmp/tiny && sudo mount -t tmpfs -o size=32m tmpfs /tmp/tiny
/// DI_TEST_TINY_DRIVE=/tmp/tiny cargo test --test offload_safety really_fills -- --ignored
/// ```
#[test]
#[ignore = "needs DI_TEST_TINY_DRIVE: a small, empty, separately mounted folder"]
fn a_drive_that_really_fills_up_mid_run_stops_it_with_every_original_in_place() {
    let tiny = std::env::var_os("DI_TEST_TINY_DRIVE").expect("set DI_TEST_TINY_DRIVE");
    let mut w = world();
    w.store = dunce::canonicalize(Path::new(&tiny))
        .unwrap()
        .join("Offload");
    fs::create_dir_all(&w.store).unwrap();
    plant(&w.src);
    let before = snap(&w.src);
    let filler = w.store.join("someone-elses-download.bin");
    let once = AtomicBool::new(false);
    let hook = On(|point, _: &Path| {
        // Once the run is under way, something else uses up the drive.
        if point == Point::FileStart && !once.swap(true, Ordering::SeqCst) {
            use std::io::Write;
            let mut file = fs::File::create(&filler).unwrap();
            let block = vec![7u8; 64 * 1024];
            while file.write_all(&block).is_ok() {}
            while file.write_all(&[7u8]).is_ok() {}
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();
    let _ = fs::remove_file(&filler);

    assert_eq!(report.stopped.as_deref(), Some("the drive is full"));
    assert_eq!(report.outcome, "incomplete");
    assert_eq!(
        snap(&w.src),
        before,
        "a run that stopped early removes nothing"
    );
    assert_eq!(report.removal, offload::Removal::default());
    assert!(
        !has_leftovers(&w.store),
        "the half-written file is discarded"
    );
    assert_catalog_true(&w);
    let _ = fs::remove_dir_all(&w.store);
}

#[test]
fn not_enough_room_is_refused_before_anything_is_written() {
    // A real small disk, where the system has one to give (Linux tmpfs).
    let shm = Path::new("/dev/shm");
    if !shm.is_dir() {
        eprintln!("skipped: no /dev/shm here");
        return;
    }
    let w = world();
    let free = fs4::available_space(shm).unwrap();
    // A sparse file "bigger" than the drive: no need to write that much.
    let huge = fs::File::create(w.src.join("huge.img")).unwrap();
    if huge.set_len(free + 1024 * 1024 * 1024).is_err() {
        eprintln!("skipped: can't make a big sparse file here");
        return;
    }
    let store = tempfile::Builder::new()
        .prefix("offload-store-")
        .tempdir_in(shm)
        .unwrap();
    let options = Options {
        remove: RemoveMode::Delete,
        allow_same_volume: false,
    };

    let refused =
        plain(|ctl| offload::offload(&mut w.catalog(), &w.src, store.path(), &options, ctl))
            .unwrap_err();

    assert!(refused.contains("Not enough room"), "{refused}");
    assert!(w.src.join("huge.img").exists());
    assert_eq!(
        fs::read_dir(store.path()).unwrap().count(),
        0,
        "nothing was written to the drive, not even the marker"
    );
    assert!(w.catalog().jobs().unwrap().is_empty());
}

#[test]
fn an_unplugged_drive_stops_the_run_and_removes_nothing() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let (store, away) = (w.store.clone(), w.root.join("unplugged"));
    let files = AtomicUsize::new(0);
    let hook = On(|point, _: &Path| {
        // After a few files, the drive is gone.
        if point == Point::FileStart && files.fetch_add(1, Ordering::SeqCst) == 3 {
            fs::rename(&store, &away).unwrap();
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!(
        report.stopped.as_deref(),
        Some("the drive is no longer connected")
    );
    assert_eq!(snap(&w.src), before);
    assert_eq!(report.removal, offload::Removal::default());
    assert!(
        report.items_seen < files_in(&before) as u64,
        "it stopped at once"
    );
    assert!(
        !w.store.exists(),
        "nothing is written to where the drive used to be"
    );

    // Plugged back in (anywhere), the same offload carries on.
    fs::rename(&away, &w.store).unwrap();
    let again = w.offload(RemoveMode::Delete, &NoHook).unwrap();
    assert_eq!(again.outcome, "complete");
    assert_eq!(snap(&w.dest()), before);
    assert_nothing_lost(&w, &before);
}

#[test]
fn an_unplugged_drive_during_removal_stops_the_removal() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let (store, away) = (w.store.clone(), w.root.join("unplugged"));
    let removed = AtomicUsize::new(0);
    let hook = On(|point, _: &Path| {
        if point == Point::Removed && removed.fetch_add(1, Ordering::SeqCst) == 1 {
            fs::rename(&store, &away).unwrap();
        }
        Ok(())
    });

    let report = w.offload(RemoveMode::Delete, &hook).unwrap();

    assert_eq!(
        report.removal.removed_files, 2,
        "only the two that were checked against the drive while it was there"
    );
    assert_eq!(report.removal.kept_files as usize, files_in(&before) - 2);
    fs::rename(&away, &w.store).unwrap();
    assert_nothing_lost(&w, &before);
    assert_report_true(&w, &before, &report);
}

// ---------------------------------------------------------------------------
// Things that can't be copied are said so, never dropped
// ---------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn an_unreadable_folder_is_a_failure_not_an_empty_folder() {
    use std::os::unix::fs::PermissionsExt;
    if is_root() {
        eprintln!(
            "skipped: root can read anything (run the tests as an ordinary user for this one)"
        );
        return;
    }
    let w = world();
    plant(&w.src);
    write(&w.src.join("locked/secret.txt"), b"can't see me");
    write(&w.src.join("locked-file.txt"), b"nor me");
    fs::set_permissions(w.src.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    fs::set_permissions(
        w.src.join("locked-file.txt"),
        fs::Permissions::from_mode(0o000),
    )
    .unwrap();

    let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();

    fs::set_permissions(w.src.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(
        w.src.join("locked-file.txt"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert_eq!((report.outcome.as_str(), report.failed), ("incomplete", 2));
    assert!(report
        .problems
        .iter()
        .any(|p| p.path == "locked" && p.message.contains("couldn't be read")));
    assert_eq!(
        fs::read(w.src.join("locked/secret.txt")).unwrap(),
        b"can't see me"
    );
    assert_eq!(fs::read(w.src.join("locked-file.txt")).unwrap(), b"nor me");
    assert_eq!(
        report.items_seen,
        report.verified_files + report.failed + report.skipped
    );
    assert_catalog_true(&w);
}

#[cfg(unix)]
#[test]
fn an_unreadable_folder_blocks_the_trash() {
    use std::os::unix::fs::PermissionsExt;
    if is_root() {
        eprintln!("skipped: root can read anything");
        return;
    }
    let w = world();
    plant(&w.src);
    write(&w.src.join("locked/secret.txt"), b"can't see me");
    fs::set_permissions(w.src.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    let bin = Bin(w.root.join("trash"));

    let report = w.offload(RemoveMode::Trash, &bin).unwrap();

    fs::set_permissions(w.src.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!report.removal.trashed && w.src.join("a.txt").exists() && !bin.0.exists());
}

#[cfg(unix)]
#[test]
fn pipes_and_sockets_are_skipped_and_stay() {
    let w = world();
    plant(&w.src);
    let pipe = w.src.join("docs/a-pipe");
    let c_path = std::ffi::CString::new(pipe.to_str().unwrap()).unwrap();
    // SAFETY: a valid NUL-terminated path.
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0);
    let before = snap(&w.src);

    let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();

    assert_eq!(
        (report.outcome.as_str(), report.skipped, report.failed),
        ("incomplete", 1, 0)
    );
    assert!(
        fs::symlink_metadata(&pipe).is_ok(),
        "the pipe is still there"
    );
    assert!(w.src.join("docs").is_dir(), "and so is its folder");
    assert!(!w.dest().join("docs/a-pipe").exists());
    assert_eq!(w.rows()["docs/a-pipe"].state, "skipped");
    assert_report_true(&w, &before, &report);

    // The Trash would take the pipe with the folder, so it refuses.
    let w = world();
    plant(&w.src);
    let c_path = std::ffi::CString::new(w.src.join("a-pipe").to_str().unwrap()).unwrap();
    // SAFETY: as above.
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0);
    let bin = Bin(w.root.join("trash"));
    let report = w.offload(RemoveMode::Trash, &bin).unwrap();
    assert!(!report.removal.trashed && w.src.join("a.txt").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn a_name_that_is_not_unicode_is_reported_and_left() {
    use std::os::unix::ffi::OsStrExt;
    let w = world();
    plant(&w.src);
    let odd = w.src.join(std::ffi::OsStr::from_bytes(b"caf\xe9.txt"));
    if fs::write(&odd, b"latin-1 name").is_err() {
        eprintln!("skipped: this file system refuses such names");
        return;
    }

    let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();

    assert_eq!(report.failed, 1);
    assert!(report
        .problems
        .iter()
        .any(|p| p.message.contains("not valid Unicode")));
    assert_eq!(fs::read(&odd).unwrap(), b"latin-1 name");
    assert!(!w.src.join("a.txt").exists(), "the rest still goes");
}

#[test]
fn leftovers_of_an_interrupted_restore_are_not_mistaken_for_files() {
    let w = world();
    plant(&w.src);
    let leftover = w.src.join(format!("{TMP_PREFIX}0123456789abcdef"));
    fs::write(&leftover, b"half a file").unwrap();

    let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();

    assert_eq!(report.skipped, 1);
    assert!(leftover.exists(), "it is not deleted either");
    assert!(!has_leftovers(&w.store));
}

#[test]
fn names_differing_only_by_case_are_not_squashed_on_a_drive_that_ignores_case() {
    let w = world();
    write(&w.src.join("Report.txt"), b"upper");
    write(&w.src.join("report.txt"), b"lower");
    write(&w.src.join("other.txt"), b"other");
    if fs::read(w.src.join("Report.txt")).unwrap() != b"upper" {
        eprintln!("skipped: this disk ignores case itself, so the two names can't both exist");
        return;
    }
    struct IgnoresCase;
    impl Hook for IgnoresCase {
        fn folds_case(&self) -> Option<bool> {
            Some(true)
        }
    }

    let report = w.offload(RemoveMode::Delete, &IgnoresCase).unwrap();

    assert_eq!((report.failed, report.verified_files), (2, 1));
    assert_eq!(fs::read(w.src.join("Report.txt")).unwrap(), b"upper");
    assert_eq!(fs::read(w.src.join("report.txt")).unwrap(), b"lower");
    assert!(!w.src.join("other.txt").exists());
    assert!(report
        .problems
        .iter()
        .all(|p| p.message.contains("upper/lower case")));
}

#[cfg(unix)]
#[test]
fn links_are_copied_as_links_and_never_followed() {
    let w = world();
    plant(&w.src);
    // Outside the folder being offloaded: must not be copied or deleted.
    let outside = w.root.join("computer/Elsewhere");
    write(&outside.join("precious.txt"), b"not part of this offload");
    std::os::unix::fs::symlink(&outside, w.src.join("link-to-elsewhere")).unwrap();
    std::os::unix::fs::symlink(outside.join("precious.txt"), w.src.join("link-to-precious"))
        .unwrap();
    // A loop.
    std::os::unix::fs::symlink(&w.src, w.src.join("docs/loop")).unwrap();
    let before = snap(&w.src);

    let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();

    assert_eq!(report.outcome, "complete");
    assert_eq!(
        fs::read(outside.join("precious.txt")).unwrap(),
        b"not part of this offload",
        "what a link points at is untouched"
    );
    assert_eq!(snap(&w.dest()), before);
    assert!(fs::symlink_metadata(w.dest().join("link-to-elsewhere"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(
        !w.dest().join("link-to-elsewhere/precious.txt").exists()
            || fs::symlink_metadata(w.dest().join("link-to-elsewhere"))
                .unwrap()
                .file_type()
                .is_symlink()
    );
    assert!(!w.src.exists());
    assert_report_true(&w, &before, &report);
}

#[cfg(unix)]
#[test]
fn hard_links_become_separate_copies_and_free_space_is_not_overstated() {
    let w = world();
    let bytes = Rng(3).bytes(400_000);
    write(&w.src.join("one.bin"), &bytes);
    fs::hard_link(w.src.join("one.bin"), w.src.join("two.bin")).unwrap();
    // A third link lives outside the folder: deleting these two frees nothing.
    fs::hard_link(w.src.join("one.bin"), w.root.join("computer/outside.bin")).unwrap();

    let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();

    assert_eq!(
        (report.outcome.as_str(), report.removal.removed_files),
        ("complete", 2)
    );
    assert_eq!(report.removal.removed_bytes, 800_000);
    assert_eq!(
        report.removal.freed_bytes, 0,
        "the data is still held by the link outside"
    );
    assert_eq!(fs::read(w.dest().join("two.bin")).unwrap(), bytes);
    assert_eq!(
        fs::read(w.root.join("computer/outside.bin")).unwrap(),
        bytes
    );
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

#[test]
fn dangerous_or_pointless_requests_are_refused_before_anything_happens() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.root);
    let loose = Options {
        remove: RemoveMode::Delete,
        allow_same_volume: true,
    };
    let refuse = |source: &Path, store: &Path, options: &Options| {
        offload::preflight(source, store, options).unwrap_err()
    };

    assert!(refuse(&w.src, &w.store, &Options::default()).contains("same disk"));
    fs::create_dir_all(w.src.join("docs/store")).unwrap();
    assert!(refuse(&w.src, &w.src.join("docs/store"), &loose)
        .contains("inside the folder being offloaded"));
    fs::remove_dir(w.src.join("docs/store")).unwrap();
    assert!(refuse(&w.store.join("x"), &w.store, &loose).contains("can't be opened"));
    fs::create_dir_all(w.store.join("sub")).unwrap();
    assert!(refuse(&w.store.join("sub"), &w.store, &loose).contains("inside the destination"));
    fs::remove_dir(w.store.join("sub")).unwrap();
    assert!(refuse(&w.src, &w.src, &loose).contains("inside"));
    assert!(refuse(&w.src, &w.root.join("no-such-drive"), &loose).contains("can't be opened"));
    assert!(
        refuse(&w.src, &w.src.join("a.txt"), &loose).contains("not a folder")
            || refuse(&w.src, &w.src.join("a.txt"), &loose).contains("inside")
    );
    let root = w.src.ancestors().last().unwrap();
    assert!(refuse(root, &w.store, &loose).contains("whole disk"));
    let home = dirs::home_dir().unwrap_or_default();
    if home.is_dir() {
        assert!(refuse(&home, &w.store, &loose).contains("home folder"));
        if let Some(parent) = home.parent().filter(|p| p.parent().is_some()) {
            assert!(refuse(parent, &w.store, &loose).contains("home folder"));
        }
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&w.src, w.root.join("link")).unwrap();
        assert!(refuse(&w.root.join("link"), &w.store, &loose).contains("is a link"));
        fs::remove_file(w.root.join("link")).unwrap();
        for system in ["/usr", "/bin", "/etc", "/opt"] {
            if Path::new(system).is_dir() {
                let refused = refuse(Path::new(system), &w.store, &loose);
                assert!(
                    refused.contains("system location") || refused.contains("is a link"),
                    "{system}: {refused}"
                );
            }
        }
    }

    assert_eq!(snap(&w.root), before, "checking writes nothing that stays");
    assert!(offload::preflight(&w.src, &w.store, &loose).is_ok());
}

#[test]
fn a_real_second_disk_is_accepted_without_the_test_override() {
    let shm = Path::new("/dev/shm");
    if !shm.is_dir() {
        eprintln!("skipped: no /dev/shm here");
        return;
    }
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let store = tempfile::Builder::new()
        .prefix("offload-store-")
        .tempdir_in(shm)
        .unwrap();
    let store_root = dunce::canonicalize(store.path()).unwrap();
    let options = Options {
        remove: RemoveMode::Delete,
        allow_same_volume: false,
    };

    let report =
        match plain(|ctl| offload::offload(&mut w.catalog(), &w.src, &store_root, &options, ctl)) {
            Err(e) if e.contains("same disk") => {
                eprintln!("skipped: /dev/shm is the same disk here");
                return;
            }
            other => other.unwrap(),
        };

    assert_eq!(report.outcome, "complete");
    let dest = offload::join_rel(
        &store_root,
        &offload::rel_base_for(&offload::host_name(), &w.src).unwrap(),
    )
    .unwrap();
    assert_eq!(snap(&dest), before);
    assert!(!w.src.exists());
}

// ---------------------------------------------------------------------------
// Release, check, restore
// ---------------------------------------------------------------------------

#[test]
fn release_rereads_every_copy_and_keeps_the_original_of_a_bad_one() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    w.offload(RemoveMode::Keep, &NoHook).unwrap();
    // Weeks pass. One copy rots on the drive, another is deleted from it.
    corrupt(&w.dest().join("big.bin"));
    fs::remove_file(w.dest().join("docs/notes.md")).unwrap();

    let report =
        plain(|ctl| offload::release(&mut w.catalog(), &w.job(), RemoveMode::Delete, ctl)).unwrap();

    assert_eq!(report.outcome, "incomplete");
    assert_eq!(report.removal.kept_files, 2);
    assert_eq!(report.removal.removed_files as usize, files_in(&before) - 2);
    assert_eq!(
        snap(&w.src).get("big.bin"),
        before.get("big.bin"),
        "the only good copy of big.bin is still on the computer"
    );
    assert_eq!(fs::read(w.src.join("docs/notes.md")).unwrap(), b"# notes\n");
    assert!(!w.src.join("a.txt").exists());
    let rows = w.rows();
    assert_eq!(rows["big.bin"].drive_state.as_deref(), Some("damaged"));
    assert_eq!(
        rows["docs/notes.md"].drive_state.as_deref(),
        Some("missing")
    );
    assert!(!rows["big.bin"].source_removed && rows["a.txt"].source_removed);
}

#[test]
fn release_needs_the_drive() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    w.offload(RemoveMode::Keep, &NoHook).unwrap();
    let job = w.job();
    fs::rename(&w.store, w.root.join("unplugged")).unwrap();

    let refused =
        plain(|ctl| offload::release(&mut w.catalog(), &job, RemoveMode::Delete, ctl)).unwrap_err();

    assert!(refused.contains("not connected"), "{refused}");
    assert_eq!(snap(&w.src), before);
    assert!(plain(|ctl| offload::release(&mut w.catalog(), &job, RemoveMode::Keep, ctl)).is_err());
}

#[test]
fn check_finds_missing_and_rotted_files_and_says_which() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    w.offload(RemoveMode::Delete, &NoHook).unwrap();
    let job = w.job();

    let clean = plain(|ctl| offload::check(&mut w.catalog(), &job, ctl)).unwrap();
    assert_eq!(
        (clean.outcome.as_str(), clean.missing, clean.damaged),
        ("ok", 0, 0)
    );
    assert_eq!(
        clean.checked as usize,
        before.len() + 1,
        "every file, link and folder, and the root"
    );
    assert_eq!(clean.ok, clean.checked);

    corrupt(&w.dest().join("docs/deep/er/file.dat"));
    fs::remove_file(w.dest().join("a.txt")).unwrap();
    fs::remove_dir(w.dest().join("docs/empty-dir")).unwrap();
    let found = plain(|ctl| offload::check(&mut w.catalog(), &job, ctl)).unwrap();

    assert_eq!(
        (found.outcome.as_str(), found.missing, found.damaged),
        ("problems", 2, 1)
    );
    assert_eq!(found.ok + found.missing + found.damaged, found.checked);
    let mut named: Vec<(&str, &str)> = found
        .problems
        .iter()
        .map(|p| (p.path.as_str(), p.kind.as_str()))
        .collect();
    named.sort();
    assert_eq!(
        named,
        [
            ("a.txt", "missing"),
            ("docs/deep/er/file.dat", "damaged"),
            ("docs/empty-dir", "missing")
        ]
    );
    let summary = &w.catalog().jobs().unwrap()[0];
    assert_eq!(
        (summary.damaged_files, summary.job.last_check_problems),
        (3, Some(3))
    );
    assert_eq!(w.catalog().problems(&job, 10).unwrap().len(), 3);
}

#[test]
fn check_of_an_unplugged_drive_condemns_nothing() {
    let w = world();
    plant(&w.src);
    w.offload(RemoveMode::Delete, &NoHook).unwrap();
    let job = w.job();
    fs::rename(&w.store, w.root.join("unplugged")).unwrap();

    assert!(plain(|ctl| offload::check(&mut w.catalog(), &job, ctl))
        .unwrap_err()
        .contains("not connected"));
    assert!(w
        .rows()
        .values()
        .all(|r| r.drive_state.as_deref() == Some("ok")));

    // Unplugged in the middle of a check: the files it could no longer see
    // are not written down as missing.
    fs::rename(w.root.join("unplugged"), &w.store).unwrap();
    let (store, away) = (w.store.clone(), w.root.join("unplugged"));
    // No hook point inside check, so pull the drive from another thread once
    // the check is under way.
    let progress = Progress::default();
    let cancel = AtomicBool::new(false);
    let result = std::thread::scope(|scope| {
        scope.spawn(|| {
            while progress.files_done.load(Ordering::Relaxed) < 2 {
                std::thread::yield_now();
            }
            // Windows won't move a folder with a file open in it; then this
            // half of the test shows nothing, and that is fine.
            let _ = fs::rename(&store, &away);
        });
        offload::check(
            &mut w.catalog(),
            &job,
            &Control {
                progress: &progress,
                cancel: &cancel,
                hook: &NoHook,
            },
        )
    });
    match result {
        Err(e) => assert!(e.contains("disconnected"), "{e}"),
        // The check may have finished before the drive went.
        Ok(report) => assert_eq!(report.outcome, "ok"),
    }
    assert!(
        w.rows()
            .values()
            .all(|r| r.drive_state.as_deref() == Some("ok")),
        "nothing was recorded as missing"
    );
}

#[test]
fn restore_brings_back_exactly_what_was_offloaded() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    let modified = fs::metadata(w.src.join("a.txt"))
        .unwrap()
        .modified()
        .unwrap();
    w.offload(RemoveMode::Delete, &NoHook).unwrap();
    assert!(!w.src.exists());

    let report =
        plain(|ctl| offload::restore(&mut w.catalog(), &w.job(), None, None, ctl)).unwrap();

    assert_eq!((report.outcome.as_str(), report.failed), ("complete", 0));
    assert_eq!(report.restored_files as usize, files_in(&before));
    assert_eq!(
        snap(&w.src),
        before,
        "byte for byte, with links and empty folders"
    );
    assert_eq!(
        snap(&w.dest()),
        before,
        "restoring takes nothing off the drive"
    );
    assert_eq!(
        fs::metadata(w.src.join("a.txt"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert!(!has_leftovers(&w.src));
    assert_catalog_true(&w);

    // Again: nothing to do, nothing rewritten.
    let again = plain(|ctl| offload::restore(&mut w.catalog(), &w.job(), None, None, ctl)).unwrap();
    assert_eq!(
        (again.restored_files, again.already_files as usize),
        (0, files_in(&before))
    );
}

#[test]
fn restore_refuses_a_damaged_copy_instead_of_handing_it_back() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    w.offload(RemoveMode::Delete, &NoHook).unwrap();
    corrupt(&w.dest().join("big.bin"));

    let report =
        plain(|ctl| offload::restore(&mut w.catalog(), &w.job(), None, None, ctl)).unwrap();

    assert_eq!((report.outcome.as_str(), report.failed), ("incomplete", 1));
    assert!(
        !w.src.join("big.bin").exists(),
        "a file known to be wrong is not put back as if it were right"
    );
    assert!(report
        .problems
        .iter()
        .any(|p| p.path == "big.bin" && p.message.contains("damaged")));
    assert_eq!(report.restored_files as usize, files_in(&before) - 1);
    assert_eq!(w.rows()["big.bin"].drive_state.as_deref(), Some("damaged"));
    assert!(!has_leftovers(&w.src));
}

#[test]
fn restore_never_overwrites_a_file_that_differs() {
    let w = world();
    plant(&w.src);
    w.offload(RemoveMode::Delete, &NoHook).unwrap();
    write(&w.src.join("a.txt"), b"ALPHA");
    write(&w.src.join("docs/notes.md"), b"written since");

    let report =
        plain(|ctl| offload::restore(&mut w.catalog(), &w.job(), None, None, ctl)).unwrap();

    assert_eq!(fs::read(w.src.join("a.txt")).unwrap(), b"ALPHA");
    assert_eq!(
        fs::read(w.src.join("docs/notes.md")).unwrap(),
        b"written since"
    );
    assert_eq!(report.failed, 2);
    assert!(report
        .problems
        .iter()
        .all(|p| p.message.contains("not overwritten")));
}

#[test]
fn restore_can_take_one_folder_to_another_place() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    w.offload(RemoveMode::Delete, &NoHook).unwrap();
    let elsewhere = w.root.join("computer/Restored");

    let report = plain(|ctl| {
        offload::restore(
            &mut w.catalog(),
            &w.job(),
            Some("docs/deep"),
            Some(&elsewhere),
            ctl,
        )
    })
    .unwrap();

    assert_eq!(
        (report.outcome.as_str(), report.restored_files),
        ("complete", 1)
    );
    let got = snap(&elsewhere);
    assert_eq!(
        got.get("docs/deep/er/file.dat"),
        before.get("docs/deep/er/file.dat")
    );
    assert_eq!(
        files_in(&got),
        1,
        "only what was asked for (docs/deeper would not count as docs/deep)"
    );
    assert!(!w.src.exists(), "the original place is left alone");
    assert!(
        w.rows()["docs/deep/er/file.dat"].source_removed,
        "restoring elsewhere doesn't put the original back"
    );
    assert!(plain(|ctl| offload::restore(
        &mut w.catalog(),
        &w.job(),
        Some("../x"),
        Some(&elsewhere),
        ctl
    ))
    .is_err());
}

#[test]
fn a_restore_cut_short_resumes_and_leaves_no_half_file() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    w.offload(RemoveMode::Delete, &NoHook).unwrap();
    let job = w.job();
    let counter = FailNth::counting();
    with(&counter, |ctl| {
        offload::restore(&mut w.catalog(), &job, None, None, ctl)
    })
    .unwrap();
    let total = counter.calls.load(Ordering::SeqCst);
    assert!(total > 10);

    for n in 0..total {
        fs::remove_dir_all(&w.src).unwrap();
        let crashed = with(&FailNth::at(n, true), |ctl| {
            offload::restore(&mut w.catalog(), &job, None, None, ctl)
        });
        assert!(crashed.is_err());
        // Whatever is there under a real name is whole.
        for (rel, item) in snap(&w.src) {
            if !rel.rsplit('/').next().unwrap().starts_with(TMP_PREFIX) {
                assert_eq!(
                    before.get(&rel),
                    Some(&item),
                    "a half-restored {rel} after crash at call {n}"
                );
            }
        }
        let report =
            plain(|ctl| offload::restore(&mut w.catalog(), &job, None, None, ctl)).unwrap();
        assert_eq!(report.outcome, "complete");
        let mut got = snap(&w.src);
        got.retain(|rel, _| !rel.rsplit('/').next().unwrap().starts_with(TMP_PREFIX));
        assert_eq!(got, before, "after crash at call {n}");
        assert_eq!(
            snap(&w.dest()),
            before,
            "the drive is never written to by a restore"
        );
    }
}

// ---------------------------------------------------------------------------
// The catalog and the drive's own record
// ---------------------------------------------------------------------------

#[test]
fn a_lost_database_is_rebuilt_from_the_drive() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.src);
    w.offload(RemoveMode::Delete, &NoHook).unwrap();
    let job = w.job();
    // The computer's database is gone.
    fs::remove_file(&w.db).unwrap();
    assert!(w.catalog().jobs().unwrap().is_empty());

    let imported = offload::import_store(&mut w.catalog(), &w.store).unwrap();

    assert_eq!(
        (
            imported.jobs_added,
            imported.files_added as usize,
            imported.rows_rejected
        ),
        (1, files_in(&before), 0)
    );
    assert_eq!(w.job(), job);
    assert_catalog_true(&w);
    assert_eq!(w.catalog().search("big.bin", 5).unwrap().len(), 1);
    // And it is good enough to restore from.
    let report = plain(|ctl| offload::restore(&mut w.catalog(), &job, None, None, ctl)).unwrap();
    assert_eq!(report.outcome, "complete");
    assert_eq!(snap(&w.src), before);
    // Importing twice adds nothing.
    let again = offload::import_store(&mut w.catalog(), &w.store).unwrap();
    assert_eq!((again.jobs_added, again.jobs_known), (0, 1));
}

#[test]
fn a_hostile_manifest_cannot_write_outside_the_restore_folder() {
    let w = world();
    plant(&w.src);
    w.offload(RemoveMode::Keep, &NoHook).unwrap();
    let job = w.job();
    fs::remove_file(&w.db).unwrap();
    // Someone edits the drive's manifest to point elsewhere.
    let manifest = w.store.join(drives::MANIFESTS).join(format!("{job}.jsonl"));
    let mut text = fs::read_to_string(&manifest).unwrap();
    let evil = |rel: &str| {
        format!("{{\"job_id\":\"x\",\"rel_path\":\"{rel}\",\"kind\":\"file\",\"size\":5,\"sha256\":\"aa\",\"state\":\"verified\",\"source_removed\":false}}\n")
    };
    text.push_str(&evil("../../escaped.txt"));
    text.push_str(&evil("/etc/escaped.txt"));
    text.push_str(&evil("docs/../../escaped.txt"));
    text.push_str("not json at all\n");
    fs::write(&manifest, text).unwrap();

    let imported = offload::import_store(&mut w.catalog(), &w.store).unwrap();

    assert_eq!(imported.rows_rejected, 4);
    assert!(w
        .rows()
        .keys()
        .all(|rel| !rel.contains("..") && !rel.starts_with('/')));
    let target = w.root.join("computer/Restored");
    plain(|ctl| offload::restore(&mut w.catalog(), &job, None, Some(&target), ctl)).unwrap();
    assert!(!w.root.join("computer/escaped.txt").exists() && !w.root.join("escaped.txt").exists());
}

#[test]
fn files_can_be_found_while_the_drive_is_unplugged() {
    let w = world();
    plant(&w.src);
    w.offload(RemoveMode::Delete, &NoHook).unwrap();
    fs::rename(&w.store, w.root.join("unplugged")).unwrap();

    let catalog = w.catalog();
    let hits = catalog.search("deep file", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].rel_path, "docs/deep/er/file.dat");
    assert_eq!(hits[0].source_path, w.src.to_string_lossy());
    assert!(hits[0].source_removed);
    let store = &catalog.stores().unwrap()[0];
    assert_eq!(
        drives::locate(store),
        None,
        "and the app knows the drive is not connected"
    );

    // Plugged in somewhere else, it is recognised by its id.
    let elsewhere = w.root.join("other-mount/Offload");
    fs::create_dir_all(elsewhere.parent().unwrap()).unwrap();
    fs::rename(w.root.join("unplugged"), &elsewhere).unwrap();
    let mut moved = store.clone();
    moved.last_path = elsewhere.to_string_lossy().into_owned();
    assert_eq!(drives::locate(&moved), Some(elsewhere));
}

// ---------------------------------------------------------------------------
// Many random trees, many random failures
// ---------------------------------------------------------------------------

fn random_tree(root: &Path, rng: &mut Rng) {
    const NAMES: &[&str] = &["a", "B", "data", "IMG_0042.JPG", "r\u{e9}sum\u{e9}.pdf", "\u{65e5}\u{672c}\u{8a9e}", "with space", "dot.ted.name", "-dash", "#hash", "a-very-long-name-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "emoji \u{1f4be}", ".hidden", "trailing~", "(1)", "semi;colon", "comma,name", "100%", "a&b", "back`tick"];
    let mut dirs = vec![root.to_path_buf()];
    for _ in 0..rng.below(8) {
        let parent = dirs[rng.below(dirs.len() as u64) as usize].clone();
        let dir = parent.join(format!(
            "{}-{}",
            NAMES[rng.below(NAMES.len() as u64) as usize],
            rng.below(1000)
        ));
        if fs::create_dir_all(&dir).is_ok() {
            dirs.push(dir);
        }
    }
    for _ in 0..1 + rng.below(14) {
        let dir = &dirs[rng.below(dirs.len() as u64) as usize];
        let name = format!(
            "{}-{}",
            NAMES[rng.below(NAMES.len() as u64) as usize],
            rng.below(1000)
        );
        // Sizes around the edges that matter: empty, tiny, one copy chunk
        // exactly, and just either side of it.
        let len = match rng.below(8) {
            0 => 0,
            1 => 1,
            2 => 1024 * 1024,
            3 => 1024 * 1024 - 1,
            4 => 1024 * 1024 + 1,
            _ => rng.below(200_000) as usize,
        };
        let bytes = rng.bytes(len);
        fs::write(dir.join(&name), bytes).unwrap();
        #[cfg(unix)]
        if rng.below(6) == 0 {
            let _ =
                std::os::unix::fs::symlink(&name, dir.join(format!("link-{}", rng.below(1000))));
        }
    }
}

#[test]
fn random_trees_survive_a_round_trip_bit_for_bit() {
    for seed in 1..=25u64 {
        let w = world();
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        random_tree(&w.src, &mut rng);
        let before = snap(&w.src);

        let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();
        assert_eq!(report.outcome, "complete", "seed {seed}: {report:#?}");
        assert!(!w.src.exists(), "seed {seed}");
        assert_eq!(snap(&w.dest()), before, "seed {seed}");
        assert_report_true(&w, &before, &report);
        assert_catalog_true(&w);

        let job = w.job();
        assert_eq!(
            plain(|ctl| offload::check(&mut w.catalog(), &job, ctl))
                .unwrap()
                .outcome,
            "ok",
            "seed {seed}"
        );
        let back = plain(|ctl| offload::restore(&mut w.catalog(), &job, None, None, ctl)).unwrap();
        assert_eq!(back.outcome, "complete", "seed {seed}");
        assert_eq!(
            snap(&w.src),
            before,
            "seed {seed}: the round trip changed something"
        );
    }
}

/// Fails or crashes at random, with a repeatable sequence.
struct Chaos {
    rng: Mutex<Rng>,
    /// One call in this many goes wrong.
    one_in: u64,
}

impl Hook for Chaos {
    fn at(&self, _point: Point, _path: &Path) -> io::Result<()> {
        let mut rng = self.rng.lock().unwrap();
        if rng.below(self.one_in) != 0 {
            return Ok(());
        }
        Err(match rng.below(4) {
            0 => crash(),
            1 => offload::disk_full(),
            2 => io::Error::from(io::ErrorKind::PermissionDenied),
            _ => io::Error::other("injected"),
        })
    }
}

#[test]
fn random_failures_in_random_trees_never_lose_a_file() {
    let mut finished_at_first_try = 0;
    for seed in 1..=60u64 {
        let w = world();
        let mut rng = Rng(seed.wrapping_mul(0x2545_f491_4f6c_dd1d));
        random_tree(&w.src, &mut rng);
        let before = snap(&w.src);
        let mode = if seed % 3 == 0 {
            RemoveMode::Keep
        } else {
            RemoveMode::Delete
        };

        // Up to five runs that each go wrong somewhere...
        for attempt in 0..5 {
            let chaos = Chaos {
                rng: Mutex::new(Rng(seed * 31 + attempt)),
                one_in: 6 + seed % 20,
            };
            let result = w.offload(mode, &chaos);
            assert_nothing_lost(&w, &before);
            if result.is_err() {
                // A crash: the next start of the app tidies the record.
                offload::recover(&mut w.catalog()).unwrap();
            }
            assert_catalog_true(&w);
            if let Ok(report) = &result {
                assert_eq!(
                    report.items_seen,
                    report.verified_files + report.failed + report.skipped,
                    "seed {seed}"
                );
                if report.outcome == "complete" && attempt == 0 {
                    finished_at_first_try += 1;
                }
            }
        }
        // ...then one that doesn't (unless a troubled run already moved the lot).
        if w.src.exists() {
            let report = w.offload(RemoveMode::Delete, &NoHook).unwrap();
            assert_eq!(report.outcome, "complete", "seed {seed}: {report:#?}");
        }
        assert_eq!(snap(&w.dest()), before, "seed {seed}");
        assert!(!w.src.exists(), "seed {seed}");
        assert!(!has_leftovers(&w.store), "seed {seed}");
        assert_nothing_lost(&w, &before);
        assert_catalog_true(&w);
    }
    assert!(
        finished_at_first_try < 30,
        "the failures must actually be hitting ({finished_at_first_try} of 60 runs were clean)"
    );
}

#[test]
fn two_folders_offloaded_to_one_drive_do_not_mix() {
    let w = world();
    let (movies, music) = (
        w.root.join("computer/Movies"),
        w.root.join("computer/Music"),
    );
    write(&movies.join("same-name.bin"), b"a movie");
    write(&music.join("same-name.bin"), b"a song");
    let none = AtomicBool::new(false);

    w.offload_from(&movies, RemoveMode::Delete, &NoHook, &none)
        .unwrap();
    w.offload_from(&music, RemoveMode::Delete, &NoHook, &none)
        .unwrap();

    assert_eq!(
        fs::read(w.dest_of(&movies).join("same-name.bin")).unwrap(),
        b"a movie"
    );
    assert_eq!(
        fs::read(w.dest_of(&music).join("same-name.bin")).unwrap(),
        b"a song"
    );
    let catalog = w.catalog();
    assert_eq!(catalog.jobs().unwrap().len(), 2);
    assert_eq!(catalog.stores().unwrap().len(), 1, "one drive, known once");
    assert_eq!(catalog.search("same-name", 10).unwrap().len(), 2);
}
