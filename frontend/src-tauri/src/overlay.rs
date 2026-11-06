//! The app floats on the desktop: one transparent, undecorated window covers
//! the screen's work area, and clicks pass through it wherever the UI has no
//! window of its own.
//!
//! macOS and Windows: the UI turns click-through on when the pointer leaves
//! its windows. An ignored window gets no mouse events at all, so a poller
//! watches the pointer and turns click-through off when it comes back over
//! one of the rects the UI last reported.
//!
//! Linux: GTK input shapes. Only the UI's windows take clicks, and the shape
//! follows them as they move.

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::WebviewWindow;

/// A window-relative rectangle in CSS pixels.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Default)]
pub struct ClickThrough {
    ignoring: AtomicBool,
    rects: Mutex<Vec<Rect>>,
}

/// Cover the work area (the screen minus menu bar, dock and taskbar) of the
/// monitor the window is on.
pub fn fit_to_work_area(window: &WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let _ = window.set_position(area.position);
        let _ = window.set_size(area.size);
    }
}

/// True when the pointer is over one of the UI's windows, or when that can't
/// be told (then the window should keep taking clicks).
fn pointer_over_ui(window: &WebviewWindow, state: &ClickThrough) -> bool {
    let (Ok(cursor), Ok(origin), Ok(scale)) = (
        window.cursor_position(),
        window.inner_position(),
        window.scale_factor(),
    ) else {
        return true;
    };
    let x = (cursor.x - origin.x as f64) / scale;
    let y = (cursor.y - origin.y as f64) / scale;
    state
        .rects
        .lock()
        .unwrap()
        .iter()
        .any(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
}

/// macOS/Windows: watch for the pointer coming back while click-through is on.
pub fn start_pointer_watch(window: WebviewWindow, state: Arc<ClickThrough>) {
    std::thread::spawn(move || loop {
        if state.ignoring.load(Ordering::Relaxed) {
            if pointer_over_ui(&window, &state) {
                state.ignoring.store(false, Ordering::Relaxed);
                let _ = window.set_ignore_cursor_events(false);
            }
            std::thread::sleep(Duration::from_millis(16));
        } else {
            std::thread::sleep(Duration::from_millis(60));
        }
    });
}

/// Let clicks through to the desktop (or stop), given where the UI's windows are.
pub fn set_click_through(
    window: &WebviewWindow,
    state: &ClickThrough,
    ignore: bool,
    rects: Vec<Rect>,
) {
    *state.rects.lock().unwrap() = rects;
    // Stale rects could say the pointer is outside when it is not; the
    // poller would undo it at once, so skip the flicker.
    let ignore = ignore && !pointer_over_ui(window, state);
    if state.ignoring.swap(ignore, Ordering::Relaxed) != ignore {
        let _ = window.set_ignore_cursor_events(ignore);
    }
}

/// Keep the poller's idea of where the windows are current while they move.
pub fn set_hit_rects(state: &ClickThrough, rects: Vec<Rect>) {
    *state.rects.lock().unwrap() = rects;
}

/// Linux: only these rects take clicks; an empty list means the whole window.
#[cfg(target_os = "linux")]
pub fn set_input_region(window: &WebviewWindow, rects: Vec<Rect>) {
    use gtk::cairo::{RectangleInt, Region};
    use gtk::prelude::*;

    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(gtk_window) = target.gtk_window() else {
            return;
        };
        let Some(gdk_window) = gtk_window.window() else {
            return;
        };
        let region = Region::create();
        if rects.is_empty() {
            let (width, height) = gtk_window.size();
            let _ = region.union_rectangle(&RectangleInt::new(0, 0, width, height));
        }
        for r in rects {
            let _ = region.union_rectangle(&RectangleInt::new(
                r.x.floor() as i32,
                r.y.floor() as i32,
                r.width.ceil() as i32,
                r.height.ceil() as i32,
            ));
        }
        gdk_window.input_shape_combine_region(&region, 0, 0);
    });
}

#[cfg(not(target_os = "linux"))]
pub fn set_input_region(_window: &WebviewWindow, _rects: Vec<Rect>) {}
