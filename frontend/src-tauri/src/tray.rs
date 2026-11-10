//! The tray (menu bar on macOS, notification area on Windows) and its mini
//! panel: a small window that drops from the icon with a one-line summary and
//! a button for each of the main window's tools.
//!
//! Left-click the icon to toggle the panel; right-click for a menu (Open,
//! Quick panel, Quit). Linux tray hosts send no clicks, so there the panel is
//! opened from the menu.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Rect, Runtime, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

pub const PANEL: &str = "tray";
const PANEL_W: f64 = 304.0;
const PANEL_H: f64 = 152.0;

/// What the panel's buttons may ask the main window to open.
const TOOLS: &[&str] = &["scan", "compare", "offload", "dhm", "di", "tips", "caches"];

/// When the panel last hid because it lost focus. Clicking the icon while the
/// panel is open blurs it first; without this the click would reopen it.
#[derive(Default)]
pub struct PanelState {
    hidden_at: Mutex<Option<Instant>>,
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.manage(PanelState::default());

    WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("tray.html".into()))
        .title("Disk Intelligence")
        .inner_size(PANEL_W, PANEL_H)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .build()?;

    let open = MenuItem::with_id(app, "open", "Open Disk Intelligence", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "panel", "Quick panel", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &panel, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Disk Intelligence")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app, None),
            "panel" => show_panel(app, None),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_panel(tray.app_handle(), rect);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Hide the panel when it loses focus, like a menu.
pub fn on_panel_event<R: Runtime>(app: &AppHandle<R>, event: &WindowEvent) {
    if let WindowEvent::Focused(false) = event {
        if let Some(panel) = app.get_webview_window(PANEL) {
            if panel.is_visible().unwrap_or(false) {
                let _ = panel.hide();
                *app.state::<PanelState>().hidden_at.lock().unwrap() = Some(Instant::now());
            }
        }
    }
}

fn toggle_panel<R: Runtime>(app: &AppHandle<R>, icon: Rect) {
    let Some(panel) = app.get_webview_window(PANEL) else {
        return;
    };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    let just_hid = app
        .state::<PanelState>()
        .hidden_at
        .lock()
        .unwrap()
        .is_some_and(|t| t.elapsed() < Duration::from_millis(300));
    if !just_hid {
        show_panel(app, Some(icon));
    }
}

/// Show the panel by the tray icon (or, with no icon position, at the top
/// right of the main display) and tell it to run its quick check.
fn show_panel<R: Runtime>(app: &AppHandle<R>, icon: Option<Rect>) {
    let Some(panel) = app.get_webview_window(PANEL) else {
        return;
    };
    if let Some(pos) = panel_position(app, icon) {
        let _ = panel.set_position(pos);
    }
    let _ = panel.show();
    let _ = panel.set_focus();
    let _ = app.emit_to(PANEL, "tray://shown", ());
}

/// Centre the panel under the icon (menu bar at the top) or above it (taskbar
/// at the bottom), kept inside the display's work area.
fn panel_position<R: Runtime>(
    app: &AppHandle<R>,
    icon: Option<Rect>,
) -> Option<PhysicalPosition<i32>> {
    let (monitor, anchor) = match icon {
        Some(rect) => {
            // Tauri reports the icon's rect in physical pixels.
            let pos = rect.position.to_physical::<f64>(1.0);
            let size = rect.size.to_physical::<f64>(1.0);
            let monitor = app
                .monitor_from_point(pos.x, pos.y)
                .ok()
                .flatten()
                .or_else(|| app.primary_monitor().ok().flatten())?;
            (monitor, Some((pos.x, pos.y, size.width, size.height)))
        }
        None => (app.primary_monitor().ok().flatten()?, None),
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (ax, ay) = (area.position.x as f64, area.position.y as f64);
    let (aw, ah) = (area.size.width as f64, area.size.height as f64);
    let (w, h) = (PANEL_W * scale, PANEL_H * scale);
    let gap = 6.0 * scale;

    let (x, y) = match anchor {
        Some((ix, iy, iw, ih)) => {
            let x = ix + iw / 2.0 - w / 2.0;
            let below = iy + ih / 2.0 < ay + ah / 2.0;
            let y = if below { iy + ih + gap } else { iy - h - gap };
            (x, y)
        }
        None => (ax + aw - w - gap, ay + gap),
    };
    let x = x.clamp(ax + gap, (ax + aw - w - gap).max(ax));
    let y = y.clamp(ay, (ay + ah - h).max(ay));
    Some(PhysicalPosition::new(x.round() as i32, y.round() as i32))
}

/// Bring the main window back, optionally opening one of its tools.
pub fn show_main<R: Runtime>(app: &AppHandle<R>, tool: Option<String>) {
    if let Some(panel) = app.get_webview_window(PANEL) {
        let _ = panel.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    let tool = tool.filter(|t| TOOLS.contains(&t.as_str()));
    let _ = app.emit_to("main", "tray://open", tool);
}

// ---------------------------------------------------------------------------
// Commands for the panel
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn tray_open(app: AppHandle, tool: Option<String>) {
    show_main(&app, tool);
}

#[tauri::command]
pub fn tray_hide(app: AppHandle) {
    if let Some(panel) = app.get_webview_window(PANEL) {
        let _ = panel.hide();
    }
}

/// The quick di check the panel runs each time it opens: `di summary --json`.
#[tauri::command]
pub async fn tray_summary(
    di: tauri::State<'_, std::sync::Arc<disk_core::di::DiRunner>>,
) -> Result<Value, String> {
    let di = di.inner().clone();
    tauri::async_runtime::spawn_blocking(move || di.summary())
        .await
        .map_err(|e| e.to_string())?
}
