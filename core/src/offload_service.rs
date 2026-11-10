//! Offloading, as the app calls it: one run at a time, with progress events
//! and cancellation by request id like scans. The work itself is in
//! [`crate::offload`]; the rules it keeps are written at the top of that file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;

use crate::catalog::{
    Catalog, DriveCatalog, DriveEntry, DriveHit, FileRow, Hit, JobSummary, StoreRecord,
};
use crate::drive_catalog::{self, CatalogReport};
use crate::drives::{self, Volume};
use crate::offload::{
    self, Candidate, CandidateOptions, CheckReport, Checked, Control, ImportReport, NoHook,
    Options, Progress, ProgressEvent, ReleaseReport, RemoveMode, Report, RestoreReport,
};
use crate::service::{Result, Service};

/// A source and destination, checked, with how much there is to move.
#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    #[serde(flatten)]
    pub checked: Checked,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoreStatus {
    #[serde(flatten)]
    pub store: StoreRecord,
    /// Where it is right now; None when its drive isn't connected.
    pub path: Option<String>,
    pub free_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogView {
    pub host: String,
    pub stores: Vec<StoreStatus>,
    pub jobs: Vec<JobSummary>,
    /// The drives that have a catalog of everything on them.
    pub drive_catalogs: Vec<DriveCatalog>,
}

/// An entry of a drive catalog, with where it is right now when the drive
/// is plugged in.
#[derive(Debug, Clone, Serialize)]
pub struct ListedEntry {
    #[serde(flatten)]
    pub entry: DriveEntry,
    /// The full path on the connected drive; None while it is unplugged.
    pub path: Option<String>,
}

/// One folder of a drive catalog, for browsing.
#[derive(Debug, Clone, Serialize)]
pub struct DriveListing {
    pub store: StoreStatus,
    pub catalog: DriveCatalog,
    pub folder: ListedEntry,
    pub entries: Vec<ListedEntry>,
    /// More entries than were listed.
    pub more: bool,
}

/// Clears the busy flag however the run ends.
struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn sql(e: rusqlite::Error) -> String {
    format!("The offload catalog couldn't be read: {e}")
}

fn remove_mode(text: &str) -> Result<RemoveMode> {
    match text {
        "keep" => Ok(RemoveMode::Keep),
        "trash" => Ok(RemoveMode::Trash),
        "delete" => Ok(RemoveMode::Delete),
        other => Err(format!("Unknown choice for the originals: {other}")),
    }
}

/// A path typed or picked in the UI. Offload does its own checks on what the
/// path is; this only refuses what can't be a path.
fn user_path(text: &str, what: &str) -> Result<PathBuf> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(format!("{what} is empty."));
    }
    if trimmed.contains('\0') || trimmed.len() > 4096 {
        return Err(format!("{what} is not a valid path."));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(format!("{what} must be a full path: {trimmed}"));
    }
    Ok(path)
}

impl Service {
    fn catalog(&self) -> Result<Catalog> {
        Catalog::open(&self.catalog_path)
            .map_err(|e| format!("The offload catalog couldn't be opened: {e}"))
    }

    /// Run one offload operation: refuse a second at once, feed progress
    /// about four times a second, and honour a cancel for `request_id`.
    fn offload_run<T>(
        &self,
        request_id: &str,
        on_progress: &mut (dyn FnMut(ProgressEvent) + Send),
        work: impl FnOnce(&mut Catalog, &Control) -> Result<T>,
    ) -> Result<T> {
        if self.offload_busy.swap(true, Ordering::SeqCst) {
            return Err("Another offload, check or restore is still running. Wait for it to finish, or cancel it.".into());
        }
        let _busy = Busy(&self.offload_busy);
        let cancel = self.cancel_flag(request_id);
        let progress = Progress::default();
        let done = AtomicBool::new(false);
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                // One report straight away, about four a second while the
                // work runs, and a last one with the final counts.
                let mut wakes = 0u32;
                loop {
                    if wakes % 5 == 0 {
                        on_progress(offload::progress_event(&progress));
                    }
                    if done.load(Ordering::Relaxed) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                    wakes += 1;
                }
                on_progress(offload::progress_event(&progress));
            });
            let result = self.catalog().and_then(|mut catalog| {
                work(
                    &mut catalog,
                    &Control {
                        progress: &progress,
                        cancel: &cancel,
                        hook: &NoHook,
                    },
                )
            });
            done.store(true, Ordering::Relaxed);
            result
        });
        self.finish_request(request_id);
        result
    }

    /// Put right the records of runs that never finished. Call once, as the
    /// app starts.
    pub fn offload_recover(&self) -> Result<u64> {
        offload::recover(&mut self.catalog()?)
    }

    /// Check a source and destination, and count what there is to move.
    pub fn offload_plan(&self, source: &str, dest: &str) -> Result<Plan> {
        let (source, dest) = (
            user_path(source, "The folder to offload")?,
            user_path(dest, "The destination")?,
        );
        let checked = offload::preflight(&source, &dest, &Options::default())?;
        let (files, bytes) = offload::estimate(Path::new(&checked.source), &AtomicBool::new(false))
            .unwrap_or((0, 0));
        Ok(Plan {
            checked,
            files,
            bytes,
        })
    }

    pub fn offload(
        &self,
        source: &str,
        dest: &str,
        remove: &str,
        request_id: &str,
        mut on_progress: impl FnMut(ProgressEvent) + Send,
    ) -> Result<Report> {
        let (source, dest) = (
            user_path(source, "The folder to offload")?,
            user_path(dest, "The destination")?,
        );
        let options = Options {
            remove: remove_mode(remove)?,
            allow_same_volume: false,
        };
        self.offload_run(request_id, &mut on_progress, |catalog, ctl| {
            offload::offload(catalog, &source, &dest, &options, ctl)
        })
    }

    pub fn offload_release(
        &self,
        job_id: &str,
        remove: &str,
        request_id: &str,
        mut on_progress: impl FnMut(ProgressEvent) + Send,
    ) -> Result<ReleaseReport> {
        let mode = remove_mode(remove)?;
        self.offload_run(request_id, &mut on_progress, |catalog, ctl| {
            offload::release(catalog, job_id, mode, ctl)
        })
    }

    pub fn offload_check(
        &self,
        job_id: &str,
        request_id: &str,
        mut on_progress: impl FnMut(ProgressEvent) + Send,
    ) -> Result<CheckReport> {
        self.offload_run(request_id, &mut on_progress, |catalog, ctl| {
            offload::check(catalog, job_id, ctl)
        })
    }

    pub fn offload_restore(
        &self,
        job_id: &str,
        only: Option<&str>,
        to: Option<&str>,
        request_id: &str,
        mut on_progress: impl FnMut(ProgressEvent) + Send,
    ) -> Result<RestoreReport> {
        let to = to
            .map(|t| user_path(t, "The folder to restore into"))
            .transpose()?;
        self.offload_run(request_id, &mut on_progress, |catalog, ctl| {
            offload::restore(catalog, job_id, only, to.as_deref(), ctl)
        })
    }

    /// Every known drive (and whether it is connected) and every offload.
    pub fn offload_catalog(&self) -> Result<CatalogView> {
        let catalog = self.catalog()?;
        let stores = catalog
            .stores()
            .map_err(sql)?
            .into_iter()
            .map(|store| {
                let path = drives::locate(&store);
                StoreStatus {
                    free_bytes: path.as_ref().and_then(|p| fs4::available_space(p).ok()),
                    path: path.map(|p| p.to_string_lossy().into_owned()),
                    store,
                }
            })
            .collect();
        Ok(CatalogView {
            host: offload::host_name(),
            stores,
            jobs: catalog.jobs().map_err(sql)?,
            drive_catalogs: catalog.drive_catalogs().map_err(sql)?,
        })
    }

    pub fn offload_search(&self, query: &str) -> Result<Vec<Hit>> {
        self.catalog()?.search(query, 300).map_err(sql)
    }

    /// What was not copied, or is missing or damaged on the drive.
    pub fn offload_problems(&self, job_id: &str) -> Result<Vec<FileRow>> {
        self.catalog()?.problems(job_id, 500).map_err(sql)
    }

    /// Folders in a finished scan worth moving to an external drive.
    pub fn offload_candidates(&self, scan_id: &str) -> Result<Vec<Candidate>> {
        let data = self.scan_data(scan_id)?;
        let catalog = self.catalog()?;
        let labels: std::collections::HashMap<String, String> = catalog
            .stores()
            .map_err(sql)?
            .into_iter()
            .map(|s| (s.id, s.label))
            .collect();
        let host = offload::host_name();
        let offloaded: Vec<_> = catalog
            .jobs()
            .map_err(sql)?
            .into_iter()
            .filter(|j| j.job.host == host)
            .map(|j| {
                let label = labels.get(&j.job.store_id).cloned().unwrap_or_default();
                (
                    j.job.state == "complete" && j.removed_files < j.verified_files,
                    label,
                    j.job,
                )
            })
            .map(|(copied, label, job)| (job, copied, label))
            .collect();
        Ok(offload::candidates(
            &data,
            &offloaded,
            &CandidateOptions::default(),
        ))
    }

    /// Read a drive's own list of what it holds into the catalog.
    pub fn offload_import(&self, path: &str) -> Result<ImportReport> {
        let path = user_path(path, "The folder")?;
        if self.offload_busy.load(Ordering::SeqCst) {
            return Err("Wait for the running offload to finish first.".into());
        }
        offload::import_store(&mut self.catalog()?, &path)
    }

    /// Forget an offload: only the catalog's record goes.
    pub fn offload_forget(&self, job_id: &str) -> Result<()> {
        if self.offload_busy.load(Ordering::SeqCst) {
            return Err("Wait for the running offload to finish first.".into());
        }
        match self.catalog()?.forget_job(job_id).map_err(sql)? {
            true => Ok(()),
            false => Err(format!("No such offload: {job_id}")),
        }
    }

    /// Catalog everything on the drive at `path` (a drive, or a folder on
    /// one), with or without anything offloaded to it.
    pub fn drive_catalog(
        &self,
        path: &str,
        request_id: &str,
        mut on_progress: impl FnMut(ProgressEvent) + Send,
    ) -> Result<CatalogReport> {
        let path = user_path(path, "The drive to catalog")?;
        self.offload_run(request_id, &mut on_progress, |catalog, ctl| {
            drive_catalog::catalog_drive(catalog, &path, ctl)
        })
    }

    /// One folder of a drive's catalog: what is in it, and where it all is
    /// now if the drive is plugged in (so it can be scanned).
    pub fn drive_list(&self, store_id: &str, rel_path: &str) -> Result<DriveListing> {
        const LIMIT: usize = 2000;
        let rel_path = rel_path.trim_matches('/');
        let catalog = self.catalog()?;
        let store = catalog
            .store(store_id)
            .map_err(sql)?
            .ok_or_else(|| format!("No such drive: {store_id}"))?;
        let summary = catalog
            .drive_catalog(store_id)
            .map_err(sql)?
            .ok_or_else(|| format!("\"{}\" has not been cataloged yet.", store.label))?;
        let folder = catalog
            .drive_entry(store_id, rel_path)
            .map_err(sql)?
            .filter(|e| e.kind == "dir")
            .ok_or_else(|| {
                format!(
                    "\"{rel_path}\" is not a folder in the catalog of \"{}\".",
                    store.label
                )
            })?;
        let mut entries = catalog
            .drive_children(store_id, rel_path, LIMIT + 1)
            .map_err(sql)?;
        let more = entries.len() > LIMIT;
        entries.truncate(LIMIT);
        let root = drives::locate(&store);
        let place = |entry: DriveEntry| ListedEntry {
            path: root
                .as_ref()
                .and_then(|root| offload::join_rel(root, &entry.rel_path))
                .map(|p| p.to_string_lossy().into_owned()),
            entry,
        };
        Ok(DriveListing {
            store: StoreStatus {
                free_bytes: root.as_ref().and_then(|p| fs4::available_space(p).ok()),
                path: root.as_ref().map(|p| p.to_string_lossy().into_owned()),
                store,
            },
            catalog: summary,
            folder: place(folder),
            entries: entries.into_iter().map(place).collect(),
            more,
        })
    }

    pub fn drive_search(&self, query: &str) -> Result<Vec<DriveHit>> {
        self.catalog()?.drive_search(query, 300).map_err(sql)
    }

    /// Forget a drive's catalog. Nothing on the drive is touched.
    pub fn drive_forget(&self, store_id: &str) -> Result<()> {
        if self.offload_busy.load(Ordering::SeqCst) {
            return Err("Wait for the running offload or catalog to finish first.".into());
        }
        match self
            .catalog()?
            .forget_drive_catalog(store_id)
            .map_err(sql)?
        {
            true => Ok(()),
            false => Err("That drive has no catalog.".into()),
        }
    }

    pub fn offload_volumes(&self) -> Vec<Volume> {
        drives::volumes()
    }
}
