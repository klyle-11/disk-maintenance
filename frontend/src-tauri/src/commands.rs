//! The app's commands. Each returns the same JSON the HTTP backend's endpoint
//! did, so the UI's api.ts reads both the same way; streams (scan progress,
//! du-hast-much, di) go over a Channel instead of server-sent events.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use diskcore::analyze::{self, ExtensionSummary, Finding};
use diskcore::compare::{self, ComparisonItem, ComparisonSummary};
use diskcore::di::{self, DiLauncher};
use diskcore::scan::{self, Progress, ScanData};
use diskcore::store::{SnapshotData, SnapshotRecord, Store};
use diskcore::util::{default_db_path, existing_dir, local_iso_now};
use diskcore::{dhm, tips};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// The API this backend speaks (see API_VERSION in frontend/src/api.ts).
const API_VERSION: u32 = 2;
/// Scans and comparisons kept in memory for findings and saving.
const KEEP_RECENT: usize = 3;

type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Serialize)]
pub struct ScanInfo {
    pub scan_id: String,
    pub root_path: String,
    pub started_at: String,
    pub completed_at: String,
    pub total_files: u64,
    pub total_folders: u64,
    pub total_size_bytes: u64,
}

pub struct StoredScan {
    info: ScanInfo,
    data: ScanData,
    findings: OnceLock<Vec<Finding>>,
    extensions: OnceLock<Vec<ExtensionSummary>>,
}

impl StoredScan {
    fn findings(&self) -> &Vec<Finding> {
        self.findings.get_or_init(|| analyze::analyze(&self.data))
    }
    fn extensions(&self) -> &Vec<ExtensionSummary> {
        self.extensions.get_or_init(|| analyze::extension_summary(&self.data))
    }
}

struct StoredComparison {
    id: String,
    source: String,
    target: String,
    tree: Vec<ComparisonItem>,
    summary: ComparisonSummary,
}

struct PendingDi {
    args: Vec<String>,
    columns: u16,
}

/// Keeps the newest few, dropping the oldest: old scans used to stay in
/// memory until the app quit.
struct Recent<T> {
    items: Vec<(String, Arc<T>)>,
}

impl<T> Recent<T> {
    fn put(&mut self, id: String, item: T) -> Arc<T> {
        let item = Arc::new(item);
        self.items.retain(|(k, _)| *k != id);
        self.items.push((id, item.clone()));
        if self.items.len() > KEEP_RECENT {
            self.items.remove(0);
        }
        item
    }
    fn get(&self, id: &str) -> Option<Arc<T>> {
        self.items.iter().find(|(k, _)| k == id).map(|(_, v)| v.clone())
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Where the UI's windows are, for letting clicks through everywhere else.
#[derive(Default)]
pub struct Overlay {
    pub regions: Vec<Region>,
    /// A drag or resize is under way: take every click until it ends.
    pub interacting: bool,
    pub reported: bool,
}

pub struct AppState {
    scans: Mutex<Recent<StoredScan>>,
    comparisons: Mutex<Recent<StoredComparison>>,
    runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pending_di: Mutex<HashMap<String, PendingDi>>,
    di: OnceLock<std::result::Result<DiLauncher, String>>,
    pub overlay: Arc<Mutex<Overlay>>,
}

impl AppState {
    pub fn new() -> AppState {
        AppState {
            scans: Mutex::new(Recent { items: Vec::new() }),
            comparisons: Mutex::new(Recent { items: Vec::new() }),
            runs: Mutex::new(HashMap::new()),
            pending_di: Mutex::new(HashMap::new()),
            di: OnceLock::new(),
            overlay: Arc::new(Mutex::new(Overlay::default())),
        }
    }

    fn start_run(&self, run_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.runs.lock().unwrap().insert(run_id.to_string(), flag.clone());
        flag
    }

    fn end_run(&self, run_id: &str) {
        self.runs.lock().unwrap().remove(run_id);
    }

    fn di(&self, app: &AppHandle) -> Result<DiLauncher> {
        self.di
            .get_or_init(|| {
                let mut roots: Vec<PathBuf> = Vec::new();
                if let Ok(resources) = app.path().resource_dir() {
                    roots.push(resources);
                }
                // A checkout, for `tauri dev`.
                roots.push(di::checkout_root());
                DiLauncher::find(&roots)
            })
            .clone()
    }
}

fn store() -> Result<Store> {
    Store::open(&default_db_path()).map_err(|e| format!("Couldn't open the snapshot database: {e}"))
}

fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serializable")
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Scan a folder from start to finish, without progress.
fn scan_now(root: PathBuf) -> (ScanInfo, ScanData) {
    let started_at = local_iso_now();
    let data = scan::scan(&root, &Progress::default(), &AtomicBool::new(false)).expect("not cancelled");
    let info = ScanInfo {
        scan_id: uuid::Uuid::new_v4().to_string(),
        root_path: root.to_string_lossy().into_owned(),
        started_at,
        completed_at: local_iso_now(),
        total_files: data.total_files,
        total_folders: data.folders.len() as u64,
        total_size_bytes: data.total_size,
    };
    (info, data)
}

fn scan_snapshot_data<'a>(root: &'a str, info: &'a ScanInfo, findings: &[Finding], extensions: &[ExtensionSummary]) -> SnapshotData<'a> {
    SnapshotData {
        scan_id: &info.scan_id,
        root_path: root,
        findings: to_json(&findings),
        extensions: to_json(&extensions),
        scan_info: to_json(info),
        total_files: info.total_files as i64,
        total_folders: info.total_folders as i64,
        total_size_bytes: info.total_size_bytes as i64,
        snapshot_type: "scan",
        target_path: None,
        comparison: None,
        comparison_summary: None,
    }
}

// ---------------------------------------------------------------------------
// Health and tips
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn health() -> Value {
    json!({ "status": "ok", "api": API_VERSION })
}

#[tauri::command]
pub async fn get_tips() -> Result<tips::TipsPayload> {
    blocking(tips::payload).await
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

/// Scan a folder, sending progress events and then a "complete" event with
/// the scan's summary (as /api/scan/stream did).
#[tauri::command]
pub async fn scan_stream(state: State<'_, AppState>, root_path: String, run_id: String, on_event: Channel<Value>) -> Result<()> {
    let root = existing_dir(&root_path, "Path")?;
    let cancel = state.start_run(&run_id);
    let scan_id = uuid::Uuid::new_v4().to_string();
    let started_at = local_iso_now();
    let progress = Arc::new(Progress::default());
    let done = Arc::new(AtomicBool::new(false));

    let ticker = {
        let (progress, done, channel, scan_id) = (progress.clone(), done.clone(), on_event.clone(), scan_id.clone());
        std::thread::spawn(move || {
            let start = Instant::now();
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(250));
                let mut event = to_json(&scan::progress_event(&progress, start.elapsed().as_secs_f64()));
                event["scan_id"] = json!(scan_id);
                event["event_type"] = json!("progress");
                let _ = channel.send(event);
            }
        })
    };

    let walk_root = root.clone();
    let walk_progress = progress.clone();
    let result = blocking(move || scan::scan(&walk_root, &walk_progress, &cancel)).await;
    done.store(true, Ordering::Relaxed);
    let _ = ticker.join();
    state.end_run(&run_id);

    let data = result?.ok_or("Scan cancelled")?;
    let info = ScanInfo {
        scan_id: scan_id.clone(),
        root_path: root.to_string_lossy().into_owned(),
        started_at,
        completed_at: local_iso_now(),
        total_files: data.total_files,
        total_folders: data.folders.len() as u64,
        total_size_bytes: data.total_size,
    };
    on_event
        .send(json!({ "scan_id": scan_id, "event_type": "complete", "scan_response": info }))
        .map_err(|e| e.to_string())?;
    state.scans.lock().unwrap().put(
        scan_id,
        StoredScan { info, data, findings: OnceLock::new(), extensions: OnceLock::new() },
    );
    Ok(())
}

fn stored_scan(state: &AppState, scan_id: &str) -> Result<Arc<StoredScan>> {
    state.scans.lock().unwrap().get(scan_id).ok_or_else(|| format!("Scan not found: {scan_id}"))
}

#[tauri::command]
pub async fn get_findings(state: State<'_, AppState>, scan_id: String) -> Result<Vec<Finding>> {
    let scan = stored_scan(&state, &scan_id)?;
    blocking(move || scan.findings().clone()).await
}

#[tauri::command]
pub async fn get_extension_summary(state: State<'_, AppState>, scan_id: String) -> Result<Vec<ExtensionSummary>> {
    let scan = stored_scan(&state, &scan_id)?;
    blocking(move || scan.extensions().clone()).await
}

/// Stop a scan, du-hast-much run or di command.
#[tauri::command]
pub fn cancel_run(state: State<'_, AppState>, run_id: String) {
    if let Some(flag) = state.runs.lock().unwrap().get(&run_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_snapshots() -> Result<Vec<SnapshotRecord>> {
    blocking(|| store()?.list().map_err(|e| e.to_string())).await?
}

#[tauri::command]
pub async fn get_snapshot(snapshot_id: String) -> Result<SnapshotRecord> {
    blocking(move || store()?.get(&snapshot_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("Snapshot not found: {snapshot_id}")))
        .await?
}

#[tauri::command]
pub async fn save_snapshot(state: State<'_, AppState>, scan_id: String, root_path: String) -> Result<SnapshotRecord> {
    let scan = stored_scan(&state, &scan_id)?;
    blocking(move || {
        let data = scan_snapshot_data(&root_path, &scan.info, scan.findings(), scan.extensions());
        store()?.insert(&format!("snapshot-{}", uuid::Uuid::new_v4()), &data).map_err(|e| e.to_string())
    })
    .await?
}

/// Re-scan a snapshot's folder and replace its contents.
#[tauri::command]
pub async fn update_snapshot(snapshot_id: String) -> Result<SnapshotRecord> {
    blocking(move || {
        let store = store()?;
        let old = store.get(&snapshot_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("Snapshot not found: {snapshot_id}"))?;
        let root = PathBuf::from(&old.root_path);
        if !root.exists() {
            return Err(format!("Path no longer exists: {}", old.root_path));
        }
        if !root.is_dir() {
            return Err(format!("Path is not a directory: {}", old.root_path));
        }
        let (info, data) = scan_now(root);
        let (findings, extensions) = (analyze::analyze(&data), analyze::extension_summary(&data));
        let fresh = scan_snapshot_data(&old.root_path, &info, &findings, &extensions);
        store.replace(&snapshot_id, &fresh).map_err(|e| e.to_string())?.ok_or_else(|| format!("Snapshot not found: {snapshot_id}"))
    })
    .await?
}

#[tauri::command]
pub async fn delete_snapshot(snapshot_id: String) -> Result<Value> {
    blocking(move || {
        if store()?.delete(&snapshot_id).map_err(|e| e.to_string())? {
            Ok(json!({ "message": "Snapshot deleted successfully" }))
        } else {
            Err(format!("Snapshot not found: {snapshot_id}"))
        }
    })
    .await?
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn compare_directories(state: State<'_, AppState>, source_path: String, target_path: String, deep_scan: bool) -> Result<Value> {
    let source = existing_dir(&source_path, "Source path")?;
    let target = existing_dir(&target_path, "Target path")?;
    let (s, t) = (source.clone(), target.clone());
    let (tree, summary) = blocking(move || compare::compare(&s, &t, deep_scan)).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let response = json!({
        "comparison_id": id,
        "source_path": source.to_string_lossy(),
        "target_path": target.to_string_lossy(),
        "summary": summary,
        "tree": tree,
        "deep_scan": deep_scan,
        "completed_at": local_iso_now(),
    });
    state.comparisons.lock().unwrap().put(
        id.clone(),
        StoredComparison {
            id,
            source: source.to_string_lossy().into_owned(),
            target: target.to_string_lossy().into_owned(),
            tree,
            summary,
        },
    );
    Ok(response)
}

fn comparison_snapshot_data<'a>(
    comparison_id: &'a str,
    source: &'a str,
    target: &'a str,
    tree: &[ComparisonItem],
    summary: &ComparisonSummary,
    scan_info: Value,
) -> SnapshotData<'a> {
    SnapshotData {
        scan_id: comparison_id,
        root_path: source,
        findings: json!([]),
        extensions: json!([]),
        scan_info,
        total_files: (summary.identical + summary.modified + summary.missing_from_target) as i64,
        total_folders: 0,
        total_size_bytes: summary.total_source_size as i64,
        snapshot_type: "comparison",
        target_path: Some(target),
        comparison: Some(to_json(&tree)),
        comparison_summary: Some(to_json(summary)),
    }
}

#[tauri::command]
pub async fn save_comparison_snapshot(state: State<'_, AppState>, source_path: String, target_path: String, comparison_id: String) -> Result<SnapshotRecord> {
    let cached = state.comparisons.lock().unwrap().get(&comparison_id);
    let source = existing_dir(&source_path, "Source path")?;
    let target = existing_dir(&target_path, "Target path")?;
    blocking(move || {
        let (source, target) = (source.to_string_lossy().into_owned(), target.to_string_lossy().into_owned());
        // The comparison the user is looking at, or a fresh one if it's gone.
        let (tree, summary) = match cached.filter(|c| c.source == source && c.target == target && c.id == comparison_id) {
            Some(c) => (c.tree.clone(), c.summary.clone()),
            None => compare::compare(source.as_ref(), target.as_ref(), false),
        };
        let now = local_iso_now();
        let scan_info = json!({
            "scan_id": comparison_id,
            "root_path": source,
            "started_at": now,
            "completed_at": now,
            "total_files": summary.identical + summary.modified + summary.missing_from_target,
            "total_folders": 0,
            "total_size_bytes": summary.total_source_size,
        });
        let data = comparison_snapshot_data(&comparison_id, &source, &target, &tree, &summary, scan_info);
        store()?.insert(&format!("comparison-{}", uuid::Uuid::new_v4()), &data).map_err(|e| e.to_string())
    })
    .await?
}

#[tauri::command]
pub async fn update_comparison_snapshot(snapshot_id: String) -> Result<SnapshotRecord> {
    blocking(move || {
        let store = store()?;
        let old = store.get(&snapshot_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("Snapshot not found: {snapshot_id}"))?;
        if old.snapshot_type != "comparison" {
            return Err("Not a comparison snapshot".into());
        }
        let target = old.target_path.clone().unwrap_or_default();
        if !PathBuf::from(&old.root_path).exists() {
            return Err(format!("Source path no longer exists: {}", old.root_path));
        }
        if !PathBuf::from(&target).exists() {
            return Err(format!("Target path no longer exists: {target}"));
        }
        let (tree, summary) = compare::compare(old.root_path.as_ref(), target.as_ref(), false);
        let data = comparison_snapshot_data(&old.scan_id, &old.root_path, &target, &tree, &summary, old.scan_info.clone());
        store.replace(&snapshot_id, &data).map_err(|e| e.to_string())?.ok_or_else(|| format!("Snapshot not found: {snapshot_id}"))
    })
    .await?
}

// ---------------------------------------------------------------------------
// du-hast-much
// ---------------------------------------------------------------------------

/// Size each folder under `path`, sending a "result" event as each finishes
/// and "done" at the end (as /api/du-hast-much/stream did). Sorting and the
/// top-N cut are the UI's.
#[tauri::command]
pub async fn dhm_stream(
    state: State<'_, AppState>,
    path: String,
    exclude: Option<Vec<String>>,
    run_id: String,
    on_event: Channel<Value>,
) -> Result<()> {
    let root = existing_dir(&path, "Path")?;
    let cancel = state.start_run(&run_id);
    let start = Instant::now();
    let channel = on_event.clone();
    let flag = cancel.clone();
    let results = blocking(move || {
        dhm::scan(&root, &exclude.unwrap_or_default(), &flag, |r| {
            let mut event = to_json(r);
            event["event_type"] = json!("result");
            let _ = channel.send(event);
        })
    })
    .await;
    state.end_run(&run_id);
    let results = results?;
    if cancel.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
    }
    on_event
        .send(json!({
            "event_type": "done",
            "total_size": results.iter().map(|r| r.size).sum::<u64>(),
            "total_files": results.iter().map(|r| r.files).sum::<u64>(),
            "elapsed_seconds": start.elapsed().as_secs_f64(),
        }))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// di
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn di_commands(app: AppHandle, state: State<'_, AppState>) -> Result<Value> {
    let launcher = state.di(&app)?;
    let commands = blocking(move || launcher.commands()).await??;
    Ok(json!({ "commands": commands }))
}

/// Check a di command and hold it until di_stream runs it. Anything that
/// deletes or schedules something fails with "CONFIRM:<why>" unless confirmed.
#[tauri::command]
pub async fn di_register(app: AppHandle, state: State<'_, AppState>, args: Vec<String>, columns: u16, confirm: bool) -> Result<Value> {
    let launcher = state.di(&app)?;
    let args = di::prepare_args(args)?;
    let checked = args.clone();
    let check = blocking(move || launcher.check(&checked)).await??;
    if let Some(reason) = check.blocked {
        return Err(reason);
    }
    if let Some(reason) = check.destructive {
        if !confirm {
            return Err(format!("CONFIRM:{reason}"));
        }
    }
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    state.pending_di.lock().unwrap().insert(run_id.clone(), PendingDi { args, columns });
    Ok(json!({ "runId": run_id }))
}

/// Run a registered di command, streaming its output.
#[tauri::command]
pub async fn di_stream(app: AppHandle, state: State<'_, AppState>, run_id: String, on_event: Channel<Value>) -> Result<()> {
    let pending = state.pending_di.lock().unwrap().remove(&run_id).ok_or("No such di run (or it already started)")?;
    let launcher = state.di(&app)?;
    let cancel = state.start_run(&run_id);
    let start = Instant::now();
    let channel = on_event.clone();
    let code = blocking(move || {
        launcher.run(&pending.args, pending.columns, &cancel, |text| {
            let _ = channel.send(json!({ "type": "out", "data": text }));
        })
    })
    .await;
    state.end_run(&run_id);
    let code = code??;
    on_event
        .send(json!({ "type": "exit", "code": code, "elapsed": start.elapsed().as_secs_f64() }))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// The desktop side: folder picker, floating windows, minimise, quit
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn select_directory(app: AppHandle) -> Result<Option<String>> {
    let picked = blocking(move || app.dialog().file().set_title("Select Directory to Scan").blocking_pick_folder()).await?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

/// Where the UI's windows are (CSS pixels in the page), so clicks anywhere
/// else go through to the desktop.
#[tauri::command]
pub fn overlay_regions(window: tauri::WebviewWindow, state: State<'_, AppState>, regions: Vec<Region>, interacting: bool) {
    #[cfg(target_os = "linux")]
    shape_window(&window, &regions);
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    let mut overlay = state.overlay.lock().unwrap();
    overlay.regions = regions;
    overlay.interacting = interacting;
    overlay.reported = true;
}

/// Linux: cut the window to the UI's windows, for drawing and for clicks.
/// Without a compositor a transparent window paints black, so this is what
/// keeps the rest of the screen visible. (A press keeps the pointer until the
/// button comes up, so drags past the edge still work.)
#[cfg(target_os = "linux")]
fn shape_window(window: &tauri::WebviewWindow, regions: &[Region]) {
    use gtk::cairo::{RectangleInt, Region as CairoRegion};
    use gtk::prelude::WidgetExt;
    // An empty shape would hide the whole window; keep the last one instead.
    if regions.is_empty() {
        return;
    }
    let rects: Vec<RectangleInt> = regions
        .iter()
        .map(|r| {
            let (x, y) = (r.x.floor() as i32, r.y.floor() as i32);
            RectangleInt::new(x, y, (r.x + r.w).ceil() as i32 - x, (r.y + r.h).ceil() as i32 - y)
        })
        .collect();
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(gtk_window) = target.gtk_window() else { return };
        let region = CairoRegion::create_rectangles(&rects);
        gtk_window.shape_combine_region(Some(&region));
        gtk_window.input_shape_combine_region(Some(&region));
    });
}

#[tauri::command]
pub fn minimize_app(window: tauri::Window) -> Result<()> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
