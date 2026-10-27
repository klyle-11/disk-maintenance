//! The app's operations, one method per former HTTP endpoint.
//!
//! Errors are user-facing strings, as the FastAPI `detail` messages were.

use crate::analyzer::{extension_summary, Analyzer};
use crate::compare;
use crate::duhast;
use crate::model::*;
use crate::paths::validate_dir;
use crate::scanner::{self, ScanData};
use crate::snapshots::{NewSnapshot, SnapshotStore};
use crate::tips::{tips_payload, TipsPayload};
use crate::util::now_local_iso;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Finished scans kept in memory for findings and snapshots. Older ones are
/// dropped; a saved snapshot does not need its scan any more.
const KEPT_SCANS: usize = 4;

pub type Result<T> = std::result::Result<T, String>;

pub struct Service {
    store: Mutex<SnapshotStore>,
    scans: Mutex<VecDeque<(ScanResponse, Arc<ScanData>)>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn db_err(e: rusqlite::Error) -> String {
    format!("Database error: {e}")
}

fn to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

impl Service {
    pub fn new(store: SnapshotStore) -> Self {
        Service {
            store: Mutex::new(store),
            scans: Mutex::new(VecDeque::new()),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    // ------------------------------------------------------------------
    // Cancellation
    // ------------------------------------------------------------------

    /// The flag for a long-running request, created on first use, so a
    /// cancel that arrives before the work starts still counts.
    fn cancel_flag(&self, request_id: &str) -> Arc<AtomicBool> {
        self.cancels.lock().unwrap().entry(request_id.to_string()).or_default().clone()
    }

    fn finish_request(&self, request_id: &str) {
        self.cancels.lock().unwrap().remove(request_id);
    }

    /// Stop a running scan or du-hast-much request.
    pub fn cancel(&self, request_id: &str) {
        self.cancel_flag(request_id).store(true, Ordering::Relaxed);
    }

    // ------------------------------------------------------------------
    // Scans and findings
    // ------------------------------------------------------------------

    fn run_scan(
        &self,
        root: &Path,
        scan_id: &str,
        cancel: &AtomicBool,
        on_progress: &mut dyn FnMut(ProgressEvent),
    ) -> Result<(Arc<ScanData>, ScanResponse)> {
        let started_at = now_local_iso();
        let data = scanner::scan(root, cancel, |p| {
            on_progress(ProgressEvent {
                scan_id: scan_id.to_string(),
                event_type: "progress",
                files_scanned: p.files_scanned,
                folders_scanned: p.folders_scanned,
                bytes_scanned: p.bytes_scanned,
                current_path: p.current_path.clone(),
                progress_percent: (20 + p.depth as u32 * 5).min(95),
                elapsed_seconds: p.elapsed.as_secs_f64(),
                message: format!("Scanning: {}", p.current_path),
            })
        })
        .map_err(|_| "Scan cancelled".to_string())?;

        let info = ScanResponse {
            scan_id: scan_id.to_string(),
            root_path: data.root.clone(),
            started_at,
            completed_at: now_local_iso(),
            total_files: data.total_files,
            total_folders: data.folders.len() as u64,
            total_size_bytes: data.total_size,
        };
        Ok((Arc::new(data), info))
    }

    fn remember(&self, info: ScanResponse, data: Arc<ScanData>) {
        let mut scans = self.scans.lock().unwrap();
        scans.push_back((info, data));
        while scans.len() > KEPT_SCANS {
            scans.pop_front();
        }
    }

    fn scan_entry(&self, scan_id: &str) -> Result<(ScanResponse, Arc<ScanData>)> {
        self.scans
            .lock()
            .unwrap()
            .iter()
            .find(|(info, _)| info.scan_id == scan_id)
            .cloned()
            .ok_or_else(|| format!("Scan not found: {scan_id}"))
    }

    fn scan_data(&self, scan_id: &str) -> Result<Arc<ScanData>> {
        self.scan_entry(scan_id).map(|(_, data)| data)
    }

    /// Scan a folder, reporting progress. Cancel with [`Service::cancel`].
    pub fn scan(
        &self,
        root_path: &str,
        request_id: &str,
        mut on_progress: impl FnMut(ProgressEvent),
    ) -> Result<ScanResponse> {
        let root = validate_dir(root_path)?;
        let cancel = self.cancel_flag(request_id);
        let scan_id = uuid::Uuid::new_v4().to_string();
        let outcome = self.run_scan(&root, &scan_id, &cancel, &mut on_progress);
        self.finish_request(request_id);
        let (data, info) = outcome?;
        self.remember(info.clone(), data);
        Ok(info)
    }

    pub fn findings(&self, scan_id: &str) -> Result<Vec<Finding>> {
        Ok(Analyzer::new(&*self.scan_data(scan_id)?).analyze())
    }

    pub fn extensions_summary(&self, scan_id: &str) -> Result<Vec<ExtensionSummary>> {
        Ok(extension_summary(&*self.scan_data(scan_id)?))
    }

    // ------------------------------------------------------------------
    // Snapshots
    // ------------------------------------------------------------------

    pub fn save_snapshot(&self, scan_id: &str, root_path: &str) -> Result<Snapshot> {
        let (info, data) = self.scan_entry(scan_id)?;
        let findings = Analyzer::new(&data).analyze();
        let extensions = extension_summary(&data);
        let id = format!("snapshot-{}", uuid::Uuid::new_v4());
        self.store
            .lock()
            .unwrap()
            .insert(NewSnapshot {
                id: &id,
                scan_id,
                root_path,
                findings: to_value(&findings),
                extensions: to_value(&extensions),
                scan_info: to_value(&info),
                total_files: info.total_files as i64,
                total_folders: info.total_folders as i64,
                total_size_bytes: info.total_size_bytes as i64,
                snapshot_type: "scan",
                target_path: None,
                comparison: None,
                comparison_summary: None,
            })
            .map_err(db_err)
    }

    pub fn list_snapshots(&self) -> Result<Vec<Snapshot>> {
        self.store.lock().unwrap().list().map_err(db_err)
    }

    pub fn get_snapshot(&self, id: &str) -> Result<Snapshot> {
        self.store
            .lock()
            .unwrap()
            .get(id)
            .map_err(db_err)?
            .ok_or_else(|| format!("Snapshot not found: {id}"))
    }

    /// Re-scan a snapshot's folder and replace its results.
    pub fn update_snapshot(&self, id: &str) -> Result<Snapshot> {
        let snapshot = self.get_snapshot(id)?;
        let root = validate_dir(&snapshot.root_path)
            .map_err(|e| e.replace("Path does not exist", "Path no longer exists"))?;
        let scan_id = uuid::Uuid::new_v4().to_string();
        let never = AtomicBool::new(false);
        let (data, info) = self.run_scan(&root, &scan_id, &never, &mut |_| {})?;
        let findings = Analyzer::new(&data).analyze();
        let extensions = extension_summary(&data);
        let totals = (
            info.total_files as i64,
            info.total_folders as i64,
            info.total_size_bytes as i64,
        );
        self.store
            .lock()
            .unwrap()
            .update_scan(id, &scan_id, &to_value(&findings), &to_value(&extensions), &to_value(&info), totals)
            .map_err(db_err)?
            .ok_or_else(|| format!("Snapshot not found: {id}"))
    }

    pub fn delete_snapshot(&self, id: &str) -> Result<Value> {
        if self.store.lock().unwrap().delete(id).map_err(db_err)? {
            Ok(json!({ "message": "Snapshot deleted successfully" }))
        } else {
            Err(format!("Snapshot not found: {id}"))
        }
    }

    // ------------------------------------------------------------------
    // Comparison
    // ------------------------------------------------------------------

    fn validate_pair(source: &str, target: &str) -> Result<(std::path::PathBuf, std::path::PathBuf)> {
        let s = validate_dir(source).map_err(|e| format!("Source: {e}"))?;
        let t = validate_dir(target).map_err(|e| format!("Target: {e}"))?;
        Ok((s, t))
    }

    pub fn compare(&self, source: &str, target: &str, deep_scan: bool) -> Result<ComparisonResponse> {
        let (s, t) = Self::validate_pair(source, target)?;
        let (tree, summary) = compare::compare(&s, &t, deep_scan);
        Ok(ComparisonResponse {
            comparison_id: uuid::Uuid::new_v4().to_string(),
            source_path: s.to_string_lossy().into_owned(),
            target_path: t.to_string_lossy().into_owned(),
            summary,
            tree,
            deep_scan,
            completed_at: now_local_iso(),
        })
    }

    pub fn save_comparison_snapshot(
        &self,
        source: &str,
        target: &str,
        comparison_id: &str,
    ) -> Result<Snapshot> {
        let (s, t) = Self::validate_pair(source, target)?;
        let (tree, summary) = compare::compare(&s, &t, false);
        let source_path = s.to_string_lossy().into_owned();
        let target_path = t.to_string_lossy().into_owned();
        let total_files = summary.identical + summary.modified + summary.missing_from_target;
        let now = now_local_iso();
        let id = format!("comparison-{}", uuid::Uuid::new_v4());
        self.store
            .lock()
            .unwrap()
            .insert(NewSnapshot {
                id: &id,
                scan_id: comparison_id,
                root_path: &source_path,
                findings: json!([]),
                extensions: json!([]),
                scan_info: json!({
                    "scan_id": comparison_id,
                    "root_path": source_path,
                    "started_at": now,
                    "completed_at": now,
                    "total_files": total_files,
                    "total_folders": 0,
                    "total_size_bytes": summary.total_source_size,
                }),
                total_files: total_files as i64,
                total_folders: 0,
                total_size_bytes: summary.total_source_size as i64,
                snapshot_type: "comparison",
                target_path: Some(&target_path),
                comparison: Some(to_value(&tree)),
                comparison_summary: Some(to_value(&summary)),
            })
            .map_err(db_err)
    }

    pub fn update_comparison_snapshot(&self, id: &str) -> Result<Snapshot> {
        let snapshot = self.get_snapshot(id)?;
        if snapshot.snapshot_type != "comparison" {
            return Err("Not a comparison snapshot".into());
        }
        let target = snapshot.target_path.clone().unwrap_or_default();
        let (s, t) = Self::validate_pair(&snapshot.root_path, &target)
            .map_err(|e| e.replace("Path does not exist", "Path no longer exists"))?;
        let (tree, summary) = compare::compare(&s, &t, false);
        let total_files = summary.identical + summary.modified + summary.missing_from_target;
        self.store
            .lock()
            .unwrap()
            .update_comparison(
                id,
                &to_value(&tree),
                &to_value(&summary),
                total_files as i64,
                summary.total_source_size as i64,
            )
            .map_err(db_err)?
            .ok_or_else(|| format!("Snapshot not found: {id}"))
    }

    // ------------------------------------------------------------------
    // du-hast-much and tips
    // ------------------------------------------------------------------

    /// Size each folder under `req.path`, calling `on_result` as each one
    /// finishes. Cancel with [`Service::cancel`].
    pub fn du_hast_much_stream(
        &self,
        req: &DuHastMuchRequest,
        request_id: &str,
        on_result: &(dyn Fn(&DuHastMuchResult) + Sync),
    ) -> Result<(Vec<DuHastMuchResult>, DuHastMuchDone)> {
        let root = validate_dir(&req.path)?;
        let cancel = self.cancel_flag(request_id);
        let started = Instant::now();
        let results = duhast::scan_directory(&root, &req.exclude, &cancel, on_result);
        self.finish_request(request_id);
        let results = results.ok_or_else(|| "Scan cancelled".to_string())?;
        let done = DuHastMuchDone {
            total_size: results.iter().map(|r| r.size).sum(),
            total_files: results.iter().map(|r| r.files).sum(),
            elapsed_seconds: started.elapsed().as_secs_f64(),
        };
        Ok((results, done))
    }

    pub fn du_hast_much(&self, req: &DuHastMuchRequest) -> Result<DuHastMuchResponse> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (mut results, done) = self.du_hast_much_stream(req, &request_id, &|_| {})?;
        duhast::sort_and_limit(&mut results, req.latest, req.top);
        Ok(DuHastMuchResponse {
            total_size: results.iter().map(|r| r.size).sum(),
            total_files: done.total_files,
            elapsed_seconds: done.elapsed_seconds,
            results,
        })
    }

    pub fn tips(&self) -> TipsPayload {
        tips_payload()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn service() -> Service {
        Service::new(SnapshotStore::in_memory().unwrap())
    }

    fn tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("proj/node_modules/pkg")).unwrap();
        fs::write(dir.path().join("proj/node_modules/pkg/index.js"), vec![b'x'; 8192]).unwrap();
        fs::write(dir.path().join("proj/readme.md"), "hi").unwrap();
        dir
    }

    #[test]
    fn scan_then_findings_then_snapshot_round_trip() {
        let svc = service();
        let dir = tree();
        let root = dir.path().to_str().unwrap();

        let info = svc.scan(root, "req-1", |_| {}).unwrap();
        assert_eq!(info.total_files, 2);
        assert!(info.total_folders >= 4);

        let findings = svc.findings(&info.scan_id).unwrap();
        assert!(findings
            .iter()
            .any(|f| f.category == "cache_candidate"));
        let exts = svc.extensions_summary(&info.scan_id).unwrap();
        assert_eq!(exts[0].extension, ".js");

        let snap = svc.save_snapshot(&info.scan_id, root).unwrap();
        assert_eq!(svc.list_snapshots().unwrap().len(), 1);
        let updated = svc.update_snapshot(&snap.id).unwrap();
        assert_ne!(updated.scan_id, snap.scan_id);
        assert_eq!(updated.total_files, Some(2));
        svc.delete_snapshot(&snap.id).unwrap();
        assert!(svc.get_snapshot(&snap.id).unwrap_err().contains("not found"));
    }

    #[test]
    fn unknown_scans_and_bad_paths_are_errors() {
        let svc = service();
        assert_eq!(svc.findings("nope").unwrap_err(), "Scan not found: nope");
        assert!(svc.scan("/definitely/not/here", "r", |_| {}).unwrap_err().contains("does not exist"));
    }

    #[test]
    fn a_cancel_before_the_scan_starts_still_cancels_it() {
        let svc = service();
        let dir = tree();
        svc.cancel("req-early");
        let err = svc.scan(dir.path().to_str().unwrap(), "req-early", |_| {}).unwrap_err();
        assert_eq!(err, "Scan cancelled");
        assert!(svc.cancels.lock().unwrap().is_empty());
    }

    #[test]
    fn old_scans_are_dropped() {
        let svc = service();
        let dir = tree();
        let root = dir.path().to_str().unwrap();
        let first = svc.scan(root, "a", |_| {}).unwrap();
        for i in 0..KEPT_SCANS {
            svc.scan(root, &format!("b{i}"), |_| {}).unwrap();
        }
        assert!(svc.findings(&first.scan_id).is_err());
    }

    #[test]
    fn comparison_snapshots() {
        let svc = service();
        let a = tree();
        let b = tempfile::tempdir().unwrap();
        let (sa, sb) = (a.path().to_str().unwrap(), b.path().to_str().unwrap());

        let cmp = svc.compare(sa, sb, false).unwrap();
        assert_eq!(cmp.summary.missing_from_target, 2);

        let snap = svc.save_comparison_snapshot(sa, sb, &cmp.comparison_id).unwrap();
        assert_eq!(snap.snapshot_type, "comparison");
        assert_eq!(snap.comparison_summary.as_ref().unwrap()["missing_from_target"], 2);

        fs::write(b.path().join("extra.txt"), "new").unwrap();
        let updated = svc.update_comparison_snapshot(&snap.id).unwrap();
        assert_eq!(updated.comparison_summary.unwrap()["extra_in_target"], 1);

        let scan_snapshot_err = svc.update_comparison_snapshot("missing").unwrap_err();
        assert!(scan_snapshot_err.contains("not found"));
    }

    #[test]
    fn du_hast_much_sorts_and_limits() {
        let svc = service();
        let dir = tree();
        fs::create_dir(dir.path().join("empty")).unwrap();
        let req = DuHastMuchRequest {
            path: dir.path().to_string_lossy().into_owned(),
            top: Some(1),
            ..Default::default()
        };
        let resp = svc.du_hast_much(&req).unwrap();
        assert_eq!(resp.results.len(), 1);
        assert_eq!(resp.results[0].name, "proj");
        assert_eq!(resp.total_files, 2);
    }
}
