//! Disk Intelligence desktop shell.
//!
//! Each command is a thin wrapper over `disk_core::Service` (or, for the di
//! window, `disk_core::di::DiRunner`); the work runs on a blocking thread so
//! the UI never stalls. Long scans stream progress through a `Channel` and
//! stop when the UI calls `cancel` (`di_stop` for di) with the same request id.

mod caches;
mod overlay;
mod tray;

use disk_core::catalog::{DriveHit, FileRow, Hit};
use disk_core::drive_catalog::CatalogReport;
use disk_core::di::{DiCheck, DiEvent, DiRunner};
use disk_core::disks::DiskInfo;
use disk_core::drives::Volume;
use disk_core::model::*;
use disk_core::offload::{
    Candidate, CheckReport, ImportReport, ProgressEvent as OffloadProgress, ReleaseReport,
    Report as OffloadReport, RestoreReport,
};
use disk_core::offload_service::{CatalogView, DriveListing, Plan};
use disk_core::snapshots::{default_db_path, SnapshotStore};
use disk_core::tips::TipsPayload;
use disk_core::Service;
use overlay::{ClickThrough, Rect};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

/// The API this app speaks, reported by `health` like the Python backend's
/// /api/health. Must match API_VERSION in frontend/src/api.ts.
const API_VERSION: u32 = 2;

type Svc<'a> = State<'a, Arc<Service>>;
type Di<'a> = State<'a, Arc<DiRunner>>;
type CmdResult<T> = Result<T, String>;

/// Run blocking work off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("Internal error: {e}"))?
}

#[tauri::command]
fn health() -> Value {
    json!({ "status": "ok", "api": API_VERSION })
}

/// Platform in Node's naming ("darwin", "win32", "linux"), as the UI expects.
#[tauri::command]
fn app_info(app: AppHandle) -> Value {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    json!({ "platform": platform, "version": app.package_info().version.to_string() })
}

#[tauri::command]
async fn tips(svc: Svc<'_>) -> CmdResult<TipsPayload> {
    let svc = svc.inner().clone();
    blocking(move || Ok(svc.tips())).await
}

/// Free space on every disk worth showing, the home disk first.
#[tauri::command]
async fn disks() -> CmdResult<Vec<DiskInfo>> {
    blocking(|| Ok(disk_core::disks::list_disks())).await
}

#[tauri::command]
async fn select_directory(app: AppHandle) -> CmdResult<Option<String>> {
    blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("Select Directory to Scan")
            .blocking_pick_folder();
        Ok(picked
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await
}

/// A native message box. Used instead of `window.alert`, which not every
/// platform's webview shows.
#[tauri::command]
async fn message_dialog(app: AppHandle, message: String) -> CmdResult<()> {
    blocking(move || {
        app.dialog()
            .message(message)
            .title("Disk Intelligence")
            .blocking_show();
        Ok(())
    })
    .await
}

/// A native OK/Cancel box, in place of `window.confirm`. True means OK.
#[tauri::command]
async fn confirm_dialog(app: AppHandle, message: String) -> CmdResult<bool> {
    blocking(move || {
        Ok(app
            .dialog()
            .message(message)
            .title("Disk Intelligence")
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show())
    })
    .await
}

/// Show a path in Finder/Explorer. Never opens or runs it.
#[tauri::command]
fn reveal_path(path: String) -> bool {
    Path::new(&path).exists() && tauri_plugin_opener::reveal_item_in_dir(&path).is_ok()
}

#[tauri::command]
fn cancel(svc: Svc<'_>, request_id: String) {
    svc.cancel(&request_id);
}

#[tauri::command]
async fn scan(
    svc: Svc<'_>,
    root_path: String,
    request_id: String,
    on_progress: Channel<ProgressEvent>,
) -> CmdResult<ScanResponse> {
    let svc = svc.inner().clone();
    blocking(move || {
        svc.scan(&root_path, &request_id, |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

#[tauri::command]
async fn findings(svc: Svc<'_>, scan_id: String) -> CmdResult<Vec<Finding>> {
    let svc = svc.inner().clone();
    blocking(move || svc.findings(&scan_id)).await
}

#[tauri::command]
async fn extensions_summary(svc: Svc<'_>, scan_id: String) -> CmdResult<Vec<ExtensionSummary>> {
    let svc = svc.inner().clone();
    blocking(move || svc.extensions_summary(&scan_id)).await
}

#[tauri::command]
async fn save_snapshot(svc: Svc<'_>, scan_id: String, root_path: String) -> CmdResult<Snapshot> {
    let svc = svc.inner().clone();
    blocking(move || svc.save_snapshot(&scan_id, &root_path)).await
}

#[tauri::command]
async fn list_snapshots(svc: Svc<'_>) -> CmdResult<Vec<Snapshot>> {
    let svc = svc.inner().clone();
    blocking(move || svc.list_snapshots()).await
}

#[tauri::command]
async fn get_snapshot(svc: Svc<'_>, snapshot_id: String) -> CmdResult<Snapshot> {
    let svc = svc.inner().clone();
    blocking(move || svc.get_snapshot(&snapshot_id)).await
}

#[tauri::command]
async fn update_snapshot(svc: Svc<'_>, snapshot_id: String) -> CmdResult<Snapshot> {
    let svc = svc.inner().clone();
    blocking(move || svc.update_snapshot(&snapshot_id)).await
}

#[tauri::command]
async fn delete_snapshot(svc: Svc<'_>, snapshot_id: String) -> CmdResult<Value> {
    let svc = svc.inner().clone();
    blocking(move || svc.delete_snapshot(&snapshot_id)).await
}

#[tauri::command]
async fn compare(
    svc: Svc<'_>,
    source_path: String,
    target_path: String,
    deep_scan: bool,
) -> CmdResult<ComparisonResponse> {
    let svc = svc.inner().clone();
    blocking(move || svc.compare(&source_path, &target_path, deep_scan)).await
}

#[tauri::command]
async fn save_comparison_snapshot(
    svc: Svc<'_>,
    source_path: String,
    target_path: String,
    comparison_id: String,
) -> CmdResult<Snapshot> {
    let svc = svc.inner().clone();
    blocking(move || svc.save_comparison_snapshot(&source_path, &target_path, &comparison_id)).await
}

#[tauri::command]
async fn update_comparison_snapshot(svc: Svc<'_>, snapshot_id: String) -> CmdResult<Snapshot> {
    let svc = svc.inner().clone();
    blocking(move || svc.update_comparison_snapshot(&snapshot_id)).await
}

#[tauri::command]
async fn du_hast_much(svc: Svc<'_>, request: DuHastMuchRequest) -> CmdResult<DuHastMuchResponse> {
    let svc = svc.inner().clone();
    blocking(move || svc.du_hast_much(&request)).await
}

#[tauri::command]
async fn du_hast_much_stream(
    svc: Svc<'_>,
    request: DuHastMuchRequest,
    request_id: String,
    on_result: Channel<DuHastMuchResult>,
) -> CmdResult<DuHastMuchDone> {
    let svc = svc.inner().clone();
    blocking(move || {
        let send = |r: &DuHastMuchResult| {
            let _ = on_result.send(r.clone());
        };
        svc.du_hast_much_stream(&request, &request_id, &send)
            .map(|(_, done)| done)
    })
    .await
}

// ---------------------------------------------------------------------------
// Offload: verified moves to an external drive, and the catalog of them
// ---------------------------------------------------------------------------

/// Check a source and a destination, and count what there is to move.
#[tauri::command]
async fn offload_plan(svc: Svc<'_>, source: String, dest: String) -> CmdResult<Plan> {
    let svc = svc.inner().clone();
    blocking(move || svc.offload_plan(&source, &dest)).await
}

/// Copy a folder to a drive, read every copy back, and only then (if asked)
/// remove the originals. `remove` is "keep", "trash" or "delete".
#[tauri::command]
async fn offload_run(
    svc: Svc<'_>,
    source: String,
    dest: String,
    remove: String,
    request_id: String,
    on_progress: Channel<OffloadProgress>,
) -> CmdResult<OffloadReport> {
    let svc = svc.inner().clone();
    blocking(move || {
        svc.offload(&source, &dest, &remove, &request_id, |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

/// Remove the originals of an earlier offload, after checking each copy again.
#[tauri::command]
async fn offload_release(
    svc: Svc<'_>,
    job_id: String,
    remove: String,
    request_id: String,
    on_progress: Channel<OffloadProgress>,
) -> CmdResult<ReleaseReport> {
    let svc = svc.inner().clone();
    blocking(move || {
        svc.offload_release(&job_id, &remove, &request_id, |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

/// Read every copy on the drive again and compare it with the catalog.
#[tauri::command]
async fn offload_check(
    svc: Svc<'_>,
    job_id: String,
    request_id: String,
    on_progress: Channel<OffloadProgress>,
) -> CmdResult<CheckReport> {
    let svc = svc.inner().clone();
    blocking(move || {
        svc.offload_check(&job_id, &request_id, |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

/// Copy an offload (or one path in it) back, to where it was or to `to`.
#[tauri::command]
async fn offload_restore(
    svc: Svc<'_>,
    job_id: String,
    only: Option<String>,
    to: Option<String>,
    request_id: String,
    on_progress: Channel<OffloadProgress>,
) -> CmdResult<RestoreReport> {
    let svc = svc.inner().clone();
    blocking(move || {
        svc.offload_restore(
            &job_id,
            only.as_deref(),
            to.as_deref(),
            &request_id,
            |event| {
                let _ = on_progress.send(event);
            },
        )
    })
    .await
}

#[tauri::command]
async fn offload_catalog(svc: Svc<'_>) -> CmdResult<CatalogView> {
    let svc = svc.inner().clone();
    blocking(move || svc.offload_catalog()).await
}

#[tauri::command]
async fn offload_search(svc: Svc<'_>, query: String) -> CmdResult<Vec<Hit>> {
    let svc = svc.inner().clone();
    blocking(move || svc.offload_search(&query)).await
}

#[tauri::command]
async fn offload_problems(svc: Svc<'_>, job_id: String) -> CmdResult<Vec<FileRow>> {
    let svc = svc.inner().clone();
    blocking(move || svc.offload_problems(&job_id)).await
}

#[tauri::command]
async fn offload_candidates(svc: Svc<'_>, scan_id: String) -> CmdResult<Vec<Candidate>> {
    let svc = svc.inner().clone();
    blocking(move || svc.offload_candidates(&scan_id)).await
}

/// Read a drive's own list of what it holds into the catalog.
#[tauri::command]
async fn offload_import(svc: Svc<'_>, path: String) -> CmdResult<ImportReport> {
    let svc = svc.inner().clone();
    blocking(move || svc.offload_import(&path)).await
}

/// Forget an offload's record. Nothing on any disk is touched.
#[tauri::command]
async fn offload_forget(svc: Svc<'_>, job_id: String) -> CmdResult<()> {
    let svc = svc.inner().clone();
    blocking(move || svc.offload_forget(&job_id)).await
}

#[tauri::command]
async fn offload_volumes(svc: Svc<'_>) -> CmdResult<Vec<Volume>> {
    let svc = svc.inner().clone();
    blocking(move || Ok(svc.offload_volumes())).await
}

/// Catalog everything on a drive (or a folder on one), offloaded or not.
#[tauri::command]
async fn drive_catalog(
    svc: Svc<'_>,
    path: String,
    request_id: String,
    on_progress: Channel<OffloadProgress>,
) -> CmdResult<CatalogReport> {
    let svc = svc.inner().clone();
    blocking(move || {
        svc.drive_catalog(&path, &request_id, |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
}

/// One folder of a drive's catalog, with paths to scan when it is plugged in.
#[tauri::command]
async fn drive_list(svc: Svc<'_>, store_id: String, rel_path: String) -> CmdResult<DriveListing> {
    let svc = svc.inner().clone();
    blocking(move || svc.drive_list(&store_id, &rel_path)).await
}

#[tauri::command]
async fn drive_search(svc: Svc<'_>, query: String) -> CmdResult<Vec<DriveHit>> {
    let svc = svc.inner().clone();
    blocking(move || svc.drive_search(&query)).await
}

/// Forget a drive's catalog. Nothing on the drive is touched.
#[tauri::command]
async fn drive_forget(svc: Svc<'_>, store_id: String) -> CmdResult<()> {
    let svc = svc.inner().clone();
    blocking(move || svc.drive_forget(&store_id)).await
}

// ---------------------------------------------------------------------------
// di: the command line, run from the di window
// ---------------------------------------------------------------------------

#[tauri::command]
async fn di_commands(di: Di<'_>) -> CmdResult<Value> {
    let di = di.inner().clone();
    blocking(move || di.commands()).await
}

/// Whether a command line may run, and whether it needs the user's OK first.
#[tauri::command]
async fn di_check(di: Di<'_>, args: Vec<String>) -> CmdResult<DiCheck> {
    let di = di.inner().clone();
    blocking(move || di.check(&args)).await
}

#[tauri::command]
async fn di_run(
    di: Di<'_>,
    args: Vec<String>,
    columns: u32,
    confirm: bool,
    request_id: String,
    on_event: Channel<DiEvent>,
) -> CmdResult<()> {
    let di = di.inner().clone();
    blocking(move || {
        di.run(&args, columns, confirm, &request_id, |event| {
            let _ = on_event.send(event);
        })
    })
    .await
}

/// A line typed at a running command's prompt (its `delete #` or `[y/n]`).
#[tauri::command]
fn di_input(di: Di<'_>, request_id: String, text: String) -> CmdResult<()> {
    di.send_input(&request_id, &text)
}

#[tauri::command]
fn di_stop(di: Di<'_>, request_id: String) {
    di.stop(&request_id);
}

/// Where diskcli's sources are: bundled with the app, or the checkout in dev.
fn diskcli_root(app: &AppHandle) -> PathBuf {
    let bundled = app.path().resource_dir().map(|d| d.join("py"));
    match bundled {
        Ok(dir) if dir.join("diskcli").join("__main__.py").is_file() => dir,
        _ => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend"),
    }
}

// ---------------------------------------------------------------------------
// The floating window
// ---------------------------------------------------------------------------

#[tauri::command]
fn minimize_window(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Dragging the cluster onto another display: move the window there. Returns
/// the pointer's place in the window afterwards, or null if it didn't move.
#[tauri::command]
fn follow_cursor_to_monitor(window: WebviewWindow) -> Option<serde_json::Value> {
    overlay::follow_cursor(&window).map(|(x, y)| json!({ "x": x, "y": y }))
}

/// macOS/Windows: let clicks through while the pointer is off the UI's windows.
#[tauri::command]
fn set_click_through(
    window: WebviewWindow,
    state: State<'_, Arc<ClickThrough>>,
    ignore: bool,
    rects: Vec<Rect>,
) {
    overlay::set_click_through(&window, &state, ignore, rects);
}

/// macOS/Windows: where the UI's windows are now (they move and animate).
#[tauri::command]
fn set_hit_rects(state: State<'_, Arc<ClickThrough>>, rects: Vec<Rect>) {
    overlay::set_hit_rects(&state, rects);
}

/// Linux: only these rects take clicks.
#[tauri::command]
fn set_input_region(window: WebviewWindow, rects: Vec<Rect>) {
    overlay::set_input_region(&window, rects);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Raspberry Pi: WebKitGTK's DMA-BUF renderer often can't get buffers from
    // the Pi's GPU driver and leaves the window blank. Use its fallback unless
    // the user set the variable (WEBKIT_DISABLE_DMABUF_RENDERER=0 turns it back on).
    #[cfg(all(target_os = "linux", any(target_arch = "aarch64", target_arch = "arm")))]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        // A second launch focuses the running window instead of fighting
        // over the snapshot database.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // The window may be hidden in the tray: bring it back.
            tray::show_main(app, None);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let store = SnapshotStore::open(&default_db_path()).or_else(|e| {
                eprintln!("Cannot open the snapshot database ({e}); snapshots will not be saved.");
                SnapshotStore::in_memory()
            })?;
            let service = Arc::new(Service::new(store));
            // An offload cut short (a crash, a power cut) may have removed
            // originals its records never caught up with. Put them right.
            let recovering = service.clone();
            std::thread::spawn(move || {
                if let Err(e) = recovering.offload_recover() {
                    eprintln!("Could not check unfinished offloads: {e}");
                }
            });
            app.manage(service);
            app.manage(Arc::new(DiRunner::new(diskcli_root(app.handle()))));

            let click_through = Arc::new(ClickThrough::default());
            app.manage(click_through.clone());
            if let Some(window) = app.get_webview_window("main") {
                overlay::fit_to_work_area(&window);
                if !cfg!(target_os = "linux") {
                    overlay::start_pointer_watch(window.clone(), click_through);
                }
                window.show()?;
            }
            app.manage(tray::InTray::default());
            // A desktop without a tray (some Linux setups) still gets the app.
            if let Err(e) = tray::setup(app.handle()) {
                eprintln!("No tray icon: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == tray::PANEL {
                tray::on_panel_event(window.app_handle(), event);
                return;
            }
            // Closing the main window (Alt+F4, the taskbar) hides it to the
            // tray, where the app keeps running; Quit is in the tray. With no
            // tray it quits: the hidden panel window would otherwise keep the
            // app running with nothing on screen.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    tray::close_main(window.app_handle());
                }
                return;
            }
            // Follow resolution changes and moves to another monitor.
            if let WindowEvent::ScaleFactorChanged { .. } = event {
                if let Some(window) = window.app_handle().get_webview_window(window.label()) {
                    overlay::fit_to_work_area(&window);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            health,
            app_info,
            tips,
            disks,
            select_directory,
            message_dialog,
            confirm_dialog,
            reveal_path,
            cancel,
            scan,
            findings,
            extensions_summary,
            save_snapshot,
            list_snapshots,
            get_snapshot,
            update_snapshot,
            delete_snapshot,
            compare,
            save_comparison_snapshot,
            update_comparison_snapshot,
            du_hast_much,
            du_hast_much_stream,
            offload_plan,
            offload_run,
            offload_release,
            offload_check,
            offload_restore,
            offload_catalog,
            offload_search,
            offload_problems,
            offload_candidates,
            offload_import,
            offload_forget,
            offload_volumes,
            drive_catalog,
            drive_list,
            drive_search,
            drive_forget,
            di_commands,
            di_check,
            di_run,
            di_input,
            di_stop,
            caches::cache_targets,
            caches::clear_caches,
            tray::tray_open,
            tray::tray_hide,
            tray::close_main_window,
            tray::keeps_running_in_tray,
            tray::tray_summary,
            minimize_window,
            quit_app,
            follow_cursor_to_monitor,
            set_click_through,
            set_hit_rects,
            set_input_region,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Disk Intelligence")
        .run(|app, event| {
            // macOS: clicking the Dock icon brings a hidden main window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main(app, None);
            }
            let _ = (app, event);
        });
}
