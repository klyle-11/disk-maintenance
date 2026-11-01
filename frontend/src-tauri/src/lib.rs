//! Disk Intelligence, the Tauri app.
//!
//! The UI is a cluster of small windows floating on the desktop: one
//! transparent, frameless window covers the screen's work area, and clicks
//! pass through it wherever the UI has no window. The disk work is the
//! diskcore crate, called directly: no server, no ports.

mod commands;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use commands::{AppState, Overlay};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Cover the work area (the screen minus menu bar, dock and taskbar) of the
/// monitor the app opens on.
fn fit_to_work_area(window: &WebviewWindow) -> tauri::Result<()> {
    let monitor = match window.current_monitor()? {
        Some(m) => Some(m),
        None => window.primary_monitor()?,
    };
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        window.set_position(PhysicalPosition::new(area.position.x, area.position.y))?;
        window.set_size(PhysicalSize::new(area.size.width, area.size.height))?;
    }
    Ok(())
}

/// macOS and Windows: let clicks through wherever the UI has no window. The
/// window can't see the pointer while it ignores it, so this asks the OS where
/// the pointer is, a few dozen times a second, and compares it with the
/// regions the UI reports. (Linux shapes the window instead: see
/// `overlay_regions`.)
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn watch_pointer(app: AppHandle, overlay: Arc<Mutex<Overlay>>) {
    std::thread::spawn(move || {
        let mut ignoring = false;
        loop {
            std::thread::sleep(Duration::from_millis(30));
            let Some(window) = app.get_webview_window("main") else { return };
            let over_a_window = {
                let overlay = overlay.lock().unwrap();
                if !overlay.reported || overlay.interacting {
                    true
                } else {
                    match (window.cursor_position(), window.inner_position(), window.scale_factor()) {
                        (Ok(cursor), Ok(origin), Ok(scale)) => {
                            let x = (cursor.x - origin.x as f64) / scale;
                            let y = (cursor.y - origin.y as f64) / scale;
                            overlay.regions.iter().any(|r| x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
                        }
                        // The pointer can't be located (e.g. pure Wayland):
                        // never let clicks through rather than lose them.
                        _ => true,
                    }
                }
            };
            if ignoring == over_a_window {
                ignoring = !over_a_window;
                let _ = window.set_ignore_cursor_events(ignoring);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // On Wayland a window can't learn where the pointer is, which click-
    // through needs; XWayland can.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    let state = AppState::new();
    let overlay = state.overlay.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window");
            fit_to_work_area(&window)?;
            window.show()?;
            #[cfg(not(target_os = "linux"))]
            watch_pointer(app.handle().clone(), overlay);
            #[cfg(target_os = "linux")]
            let _ = overlay;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::health,
            commands::get_tips,
            commands::scan_stream,
            commands::get_findings,
            commands::get_extension_summary,
            commands::cancel_run,
            commands::get_snapshots,
            commands::get_snapshot,
            commands::save_snapshot,
            commands::update_snapshot,
            commands::delete_snapshot,
            commands::compare_directories,
            commands::save_comparison_snapshot,
            commands::update_comparison_snapshot,
            commands::dhm_stream,
            commands::di_commands,
            commands::di_register,
            commands::di_stream,
            commands::select_directory,
            commands::ask_dialog,
            commands::message_dialog,
            commands::overlay_regions,
            commands::minimize_app,
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Disk Intelligence");
}
