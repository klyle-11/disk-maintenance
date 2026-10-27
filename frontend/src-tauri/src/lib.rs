//! Disk Intelligence desktop shell.
//!
//! Each command is a thin wrapper over `disk_core::Service`; the work runs on
//! a blocking thread so the UI never stalls. Long scans stream progress
//! through a `Channel` and stop when the UI calls `cancel` with the same
//! request id.

use disk_core::model::*;
use disk_core::snapshots::{default_db_path, SnapshotStore};
use disk_core::tips::TipsPayload;
use disk_core::Service;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

type Svc<'a> = State<'a, Arc<Service>>;
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
    json!({ "status": "ok" })
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

#[tauri::command]
async fn select_directory(app: AppHandle) -> CmdResult<Option<String>> {
    blocking(move || {
        let picked = app.dialog().file().set_title("Select Directory to Scan").blocking_pick_folder();
        Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
    })
    .await
}

/// A native message box. Used instead of `window.alert`, which not every
/// platform's webview shows.
#[tauri::command]
async fn message_dialog(app: AppHandle, message: String) -> CmdResult<()> {
    blocking(move || {
        app.dialog().message(message).title("Disk Intelligence").blocking_show();
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
        svc.du_hast_much_stream(&request, &request_id, &send).map(|(_, done)| done)
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch focuses the running window instead of fighting
        // over the snapshot database.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let store = SnapshotStore::open(&default_db_path())
                .or_else(|e| {
                    eprintln!("Cannot open the snapshot database ({e}); snapshots will not be saved.");
                    SnapshotStore::in_memory()
                })?;
            app.manage(Arc::new(Service::new(store)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            app_info,
            tips,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Disk Intelligence");
}
