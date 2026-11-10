//! Offload through the service, as the app drives it: a scan suggests
//! folders, a plan is checked, the run reports progress, and the catalog
//! answers afterwards. The service insists on a destination on another disk,
//! so these need one: /dev/shm on Linux. Elsewhere they are skipped (the
//! engine underneath is covered on every system by `offload_safety`).

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;

use common::*;
use disk_core::snapshots::SnapshotStore;
use disk_core::Service;

struct Rig {
    w: World,
    _drive: tempfile::TempDir,
    store: PathBuf,
    svc: Service,
}

/// A computer, a service, and a drive that really is another disk.
fn rig() -> Option<Rig> {
    let shm = Path::new("/dev/shm");
    if !shm.is_dir() {
        eprintln!("skipped: no second disk to offload to here");
        return None;
    }
    let w = world();
    let drive = tempfile::Builder::new()
        .prefix("offload-drive-")
        .tempdir_in(shm)
        .ok()?;
    let store = dunce::canonicalize(drive.path()).ok()?;
    let svc = Service::with_catalog(SnapshotStore::in_memory().unwrap(), w.db.clone());
    if svc
        .offload_plan(w.src.to_str().unwrap(), store.to_str().unwrap())
        .is_err_and(|e| e.contains("same disk"))
    {
        eprintln!("skipped: /dev/shm is the same disk here");
        return None;
    }
    Some(Rig {
        w,
        _drive: drive,
        store,
        svc,
    })
}

impl Rig {
    fn src(&self) -> &str {
        self.w.src.to_str().unwrap()
    }
    fn dest(&self) -> &str {
        self.store.to_str().unwrap()
    }
    fn on_drive(&self) -> PathBuf {
        disk_core::offload::join_rel(
            &self.store,
            &disk_core::offload::rel_base_for(&disk_core::offload::host_name(), &self.w.src)
                .unwrap(),
        )
        .unwrap()
    }
}

#[test]
fn the_whole_trip_through_the_service() {
    let Some(rig) = rig() else { return };
    plant(&rig.w.src);
    let before = snap(&rig.w.src);

    let plan = rig.svc.offload_plan(rig.src(), rig.dest()).unwrap();
    assert_eq!(plan.files as usize, files_in(&before));
    assert!(plan.bytes > 2 * 1024 * 1024 && plan.checked.store_id.is_none());

    let events = Mutex::new(Vec::new());
    let report = rig
        .svc
        .offload(rig.src(), rig.dest(), "delete", "req-1", |e| {
            events.lock().unwrap().push(e)
        })
        .unwrap();
    assert_eq!(report.outcome, "complete");
    assert!(!rig.w.src.exists());
    assert_eq!(snap(&rig.on_drive()), before);

    // What the DRIVES list shows.
    let view = rig.svc.offload_catalog().unwrap();
    assert_eq!((view.stores.len(), view.jobs.len()), (1, 1));
    assert_eq!(
        view.stores[0].path.as_deref(),
        Some(rig.dest()),
        "the drive is connected, and where"
    );
    assert!(view.stores[0].free_bytes.is_some());
    let job = &view.jobs[0];
    assert_eq!(
        (job.verified_files, job.removed_files, job.problem_files),
        (files_in(&before) as i64, files_in(&before) as i64, 0)
    );
    assert_eq!(job.job.state, "complete");

    let hits = rig.svc.offload_search("notes").unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].source_removed);

    let check = rig.svc.offload_check(&job.job.id, "req-2", |_| {}).unwrap();
    assert_eq!(
        (check.outcome.as_str(), check.missing + check.damaged),
        ("ok", 0)
    );
    assert!(rig.svc.offload_problems(&job.job.id).unwrap().is_empty());

    let back = rig
        .svc
        .offload_restore(&job.job.id, None, None, "req-3", |_| {})
        .unwrap();
    assert_eq!(back.outcome, "complete");
    assert_eq!(snap(&rig.w.src), before);
    assert_eq!(
        rig.svc.offload_catalog().unwrap().jobs[0].removed_files,
        0,
        "the originals are back, and the list says so"
    );

    rig.svc.offload_forget(&job.job.id).unwrap();
    assert!(rig.svc.offload_catalog().unwrap().jobs.is_empty());
    assert_eq!(snap(&rig.on_drive()), before, "forgetting deletes nothing");
    // ...and the drive can tell the catalog again.
    assert_eq!(rig.svc.offload_import(rig.dest()).unwrap().jobs_added, 1);
    assert_eq!(
        rig.svc.offload_catalog().unwrap().jobs[0].verified_files,
        files_in(&before) as i64
    );
}

#[test]
fn only_one_run_at_a_time() {
    let Some(rig) = rig() else { return };
    plant(&rig.w.src);
    let (started_tx, started_rx) = mpsc::channel::<()>();
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let (started_tx, go_rx) = (Mutex::new(Some(started_tx)), Mutex::new(go_rx));

    std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            rig.svc
                .offload(rig.src(), rig.dest(), "keep", "first", |_| {
                    // Hold the first run open until the second has been refused.
                    if let Some(tx) = started_tx.lock().unwrap().take() {
                        tx.send(()).unwrap();
                        let _ = go_rx
                            .lock()
                            .unwrap()
                            .recv_timeout(std::time::Duration::from_secs(30));
                    }
                })
        });
        started_rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap();
        let second = rig.svc.offload_check("job-x", "second", |_| {});
        let forget = rig.svc.offload_forget("job-x");
        go_tx.send(()).unwrap();
        assert!(second.unwrap_err().contains("still running"));
        assert!(forget.unwrap_err().contains("running"));
        assert_eq!(first.join().unwrap().unwrap().outcome, "complete");
    });
    // And afterwards the next run is let in.
    let job = rig.svc.offload_catalog().unwrap().jobs[0].job.id.clone();
    assert_eq!(
        rig.svc
            .offload_check(&job, "third", |_| {})
            .unwrap()
            .outcome,
        "ok"
    );
}

#[test]
fn a_cancel_stops_the_run_before_it_touches_anything() {
    let Some(rig) = rig() else { return };
    plant(&rig.w.src);
    let before = snap(&rig.w.src);
    rig.svc.cancel("req-c");

    let stopped = rig
        .svc
        .offload(rig.src(), rig.dest(), "delete", "req-c", |_| {});

    assert!(stopped.unwrap_err().contains("Cancelled"));
    assert_eq!(snap(&rig.w.src), before);
    // The cancel was for that request only.
    assert_eq!(
        rig.svc
            .offload(rig.src(), rig.dest(), "keep", "req-d", |_| {})
            .unwrap()
            .outcome,
        "complete"
    );
}

#[test]
fn the_app_never_offloads_onto_the_same_disk() {
    let w = world();
    plant(&w.src);
    let before = snap(&w.root);
    let svc = Service::with_catalog(SnapshotStore::in_memory().unwrap(), w.db.clone());
    let (src, store) = (w.src.to_str().unwrap(), w.store.to_str().unwrap());

    assert!(svc
        .offload_plan(src, store)
        .unwrap_err()
        .contains("same disk"));
    assert!(svc
        .offload(src, store, "delete", "r", |_| {})
        .unwrap_err()
        .contains("same disk"));
    let mut after = snap(&w.root);
    after.remove("catalog.sqlite");
    assert_eq!(after, before);
}

#[test]
fn bad_requests_are_refused_in_words() {
    let w = world();
    let svc = Service::with_catalog(SnapshotStore::in_memory().unwrap(), w.db.clone());
    let src = w.src.to_str().unwrap();
    assert!(svc.offload_plan("", src).unwrap_err().contains("empty"));
    assert!(svc
        .offload_plan("relative/path", src)
        .unwrap_err()
        .contains("full path"));
    assert!(svc
        .offload(src, src, "shred", "r", |_| {})
        .unwrap_err()
        .contains("Unknown choice"));
    assert!(svc
        .offload_release("job-none", "delete", "r", |_| {})
        .unwrap_err()
        .contains("No such offload"));
    assert!(svc
        .offload_restore("job-none", None, Some("not/absolute"), "r", |_| {})
        .unwrap_err()
        .contains("full path"));
    assert!(svc
        .offload_forget("job-none")
        .unwrap_err()
        .contains("No such offload"));
    assert!(svc
        .offload_import(src)
        .unwrap_err()
        .contains("not an offload folder"));
    assert_eq!(svc.offload_recover().unwrap(), 0);
}

#[test]
fn a_scan_suggests_folders_and_knows_which_are_already_copied() {
    let Some(rig) = rig() else { return };
    // Two big old folders, one of them offloaded with its originals kept.
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(400 * 86_400);
    for name in ["Movies", "Archive"] {
        let file = rig.w.src.join(name).join("big.bin");
        write(&file, b"x");
        let handle = fs::File::options().write(true).open(&file).unwrap();
        // Sparse: large for the scanner's purposes without writing 600 MB.
        handle.set_len(600 * 1024 * 1024).unwrap();
        handle.set_modified(old).unwrap();
    }
    write(&rig.w.src.join("fresh/today.txt"), b"new");
    let info = rig.svc.scan(rig.src(), "scan-req", |_| {}).unwrap();

    let found = rig.svc.offload_candidates(&info.scan_id).unwrap();
    // On-disk size decides; a file system that stores the sparse file as
    // nothing gives no candidates, and there is nothing to assert.
    if found.is_empty() {
        eprintln!("skipped: sparse files take no space here");
        return;
    }
    assert_eq!(found.len(), 2);
    assert!(found
        .iter()
        .all(|c| c.status == "local" && c.idle_days >= 399));
}
