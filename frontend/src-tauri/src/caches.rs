//! The di window's "Clear caches" button (see diskcore::caches).

use diskcore::caches::{self, ClearReport};
use serde_json::{json, Value};
use tauri::ipc::Channel;

/// Whether this OS has a cache clear, and the folders it would empty.
#[tauri::command]
pub async fn cache_targets() -> Result<Value, String> {
    let targets = tauri::async_runtime::spawn_blocking(caches::targets).await.map_err(|e| e.to_string())?;
    Ok(json!({ "supported": caches::SUPPORTED, "targets": targets }))
}

/// Clear them, sending progress lines; the OS asks for an administrator first.
#[tauri::command]
pub async fn clear_caches(on_event: Channel<Value>) -> Result<ClearReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        caches::clear(|line| {
            let _ = on_event.send(json!({ "type": "line", "text": line }));
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
