//! Cataloging a drive on its own, before (or without) offloading anything to
//! it: what is listed, how folders add up, browsing by folder with the paths
//! a scan needs, search, and that a cancelled run keeps the last catalog.

use std::fs;
use std::path::{Path, PathBuf};

use disk_core::drives;
use disk_core::snapshots::SnapshotStore;
use disk_core::Service;

struct Rig {
    _tmp: tempfile::TempDir,
    drive: PathBuf,
    svc: Service,
}

fn rig() -> Rig {
    let tmp = tempfile::Builder::new()
        .prefix("drive-catalog-")
        .tempdir_in(env!("CARGO_TARGET_TMPDIR"))
        .unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    let drive = root.join("drive");
    fs::create_dir_all(&drive).unwrap();
    let svc = Service::with_catalog(SnapshotStore::in_memory().unwrap(), root.join("db.sqlite"));
    Rig {
        _tmp: tmp,
        drive,
        svc,
    }
}

fn write(path: &Path, bytes: usize) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, vec![b'x'; bytes]).unwrap();
}

impl Rig {
    fn catalog(&self, request: &str) -> disk_core::drive_catalog::CatalogReport {
        self.svc
            .drive_catalog(self.drive.to_str().unwrap(), request, |_| {})
            .unwrap()
    }
}

#[test]
fn a_drive_is_cataloged_without_any_offload() {
    let r = rig();
    write(&r.drive.join("Photos/2023/a.jpg"), 300);
    write(&r.drive.join("Photos/2023/b.jpg"), 200);
    write(&r.drive.join("Photos/c.jpg"), 50);
    write(&r.drive.join("Music/song.mp3"), 1000);
    write(&r.drive.join("notes.txt"), 7);
    // The app's own files and an offload's half-written file are left out.
    write(&r.drive.join(".di-catalog/x.jsonl"), 5);
    write(&r.drive.join("Photos/.di-part-123"), 5);
    #[cfg(unix)]
    std::os::unix::fs::symlink("/nowhere", r.drive.join("link")).unwrap();

    let report = r.catalog("one");
    assert_eq!(report.outcome, "complete");
    let links = if cfg!(unix) { 1 } else { 0 };
    assert_eq!(report.files, 5 + links);
    assert_eq!(report.dirs, 3);
    assert_eq!(report.bytes, 1557);
    assert_eq!(report.unreadable, 0);

    // The drive now knows itself, so a later offload to it is the same drive.
    let marker = drives::read_marker(&r.drive).unwrap().unwrap();
    assert_eq!(marker.id, report.store_id);
    let view = r.svc.offload_catalog().unwrap();
    assert_eq!(view.stores.len(), 1);
    assert!(view.jobs.is_empty());
    assert_eq!(view.drive_catalogs.len(), 1);
    assert_eq!(view.drive_catalogs[0].files, 5 + links);

    // Browsing: folders first and biggest first, each with a path to scan.
    let top = r.svc.drive_list(&report.store_id, "").unwrap();
    let names: Vec<_> = top.entries.iter().map(|e| e.entry.name.as_str()).collect();
    let mut expected = vec!["Music", "Photos", "notes.txt"];
    if cfg!(unix) {
        expected.push("link");
    }
    assert_eq!(names, expected);
    assert_eq!(top.folder.entry.size, 1557);
    assert_eq!(top.folder.path.as_deref(), r.drive.to_str());
    let photos = &top.entries[1];
    assert_eq!((photos.entry.size, photos.entry.files), (550, 3));
    assert_eq!(
        photos.path.as_deref().map(PathBuf::from),
        Some(r.drive.join("Photos"))
    );

    let inner = r.svc.drive_list(&report.store_id, "Photos/2023").unwrap();
    assert_eq!(inner.folder.entry.size, 500);
    assert_eq!(inner.entries.len(), 2);
    assert_eq!(inner.entries[0].entry.rel_path, "Photos/2023/a.jpg");

    // Only folders can be opened, and only inside the drive.
    assert!(r.svc.drive_list(&report.store_id, "notes.txt").is_err());
    assert!(r.svc.drive_list(&report.store_id, "../etc").is_err());

    let hits = r.svc.drive_search("2023 JPG").unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().all(|h| h.store_id == report.store_id));
    assert!(r.svc.drive_search("di-catalog").unwrap().is_empty());
}

#[test]
fn a_new_catalog_replaces_the_old_and_a_cancelled_one_changes_nothing() {
    let r = rig();
    write(&r.drive.join("old/a.bin"), 10);
    let first = r.catalog("first");
    write(&r.drive.join("new/b.bin"), 20);
    fs::remove_dir_all(r.drive.join("old")).unwrap();

    // Cancelled before it starts: the old catalog is still the catalog.
    r.svc.cancel("stopped");
    let stopped = r.catalog("stopped");
    assert_eq!(stopped.outcome, "cancelled");
    let names = |r: &Rig| -> Vec<String> {
        r.svc
            .drive_list(&first.store_id, "")
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.entry.name)
            .collect()
    };
    assert_eq!(names(&r), ["old"]);

    let second = r.catalog("second");
    assert_eq!(
        second.store_id, first.store_id,
        "the same drive, known by its marker"
    );
    assert_eq!(names(&r), ["new"]);
    assert_eq!(r.svc.drive_search("a.bin").unwrap().len(), 0);
    assert_eq!(
        r.svc.drive_list(&first.store_id, "").unwrap().catalog.bytes,
        20
    );

    // Forgetting the catalog leaves the drive and its files alone.
    r.svc.drive_forget(&first.store_id).unwrap();
    assert!(r.svc.drive_list(&first.store_id, "").is_err());
    assert!(r.drive.join("new/b.bin").exists());
    assert!(r.svc.offload_catalog().unwrap().drive_catalogs.is_empty());
}

#[test]
fn an_unplugged_drive_can_be_browsed_but_has_no_paths() {
    let r = rig();
    write(&r.drive.join("Docs/a.txt"), 3);
    let report = r.catalog("one");
    // "Unplug" it: the marker is gone from where it was.
    let away = r.drive.with_file_name("elsewhere-unmounted");
    fs::rename(&r.drive, &away).unwrap();
    let listing = r.svc.drive_list(&report.store_id, "").unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert!(listing.store.path.is_none());
    assert!(listing.folder.path.is_none());
    assert!(listing.entries[0].path.is_none());
}
