//! The app floats on the desktop: one transparent, undecorated window covers
//! the screen's work area, and clicks pass through it wherever the UI has no
//! window of its own.
//!
//! macOS and Windows: the UI reports where its windows are, and a poller
//! watches the pointer, turning click-through off while it is over one of
//! them and back on when it leaves.
//!
//! Linux: GTK input shapes. Only the UI's windows take clicks, and the shape
//! follows them as they move.

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{LogicalPosition, LogicalSize, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

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
    /// A press that began on one of the UI's windows is still down (a drag
    /// or a resize): keep taking the mouse wherever the pointer goes.
    held: AtomicBool,
    rects: Mutex<Vec<Rect>>,
}

/// A rectangle on the desktop, in the units the OS places windows in: points
/// on macOS, physical pixels elsewhere.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Area {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Area {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

/// What to divide a "physical" coordinate by to get desktop units.
///
/// macOS lays every display out in one space of points, and the physical
/// values Tauri reports are those points times the scale of whichever display
/// (or window) is being asked about. With a Retina display next to a plain
/// one, physical values from different displays do not line up, so on macOS
/// everything is taken back to points first. Elsewhere physical pixels are
/// already one shared space.
fn desk_scale(scale: f64) -> f64 {
    if cfg!(target_os = "macos") && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn to_area(position: PhysicalPosition<i32>, size: PhysicalSize<u32>, scale: f64) -> Area {
    let s = desk_scale(scale);
    Area {
        x: position.x as f64 / s,
        y: position.y as f64 / s,
        w: size.width as f64 / s,
        h: size.height as f64 / s,
    }
}

fn bounds(monitor: &Monitor) -> Area {
    to_area(*monitor.position(), *monitor.size(), monitor.scale_factor())
}

fn work_area(monitor: &Monitor) -> Area {
    let area = monitor.work_area();
    to_area(area.position, area.size, monitor.scale_factor())
}

/// The pointer, in desktop units. (macOS reports it scaled by the primary
/// display, whichever display it is on.)
fn cursor(window: &WebviewWindow) -> Option<(f64, f64)> {
    let cursor = window.cursor_position().ok()?;
    let scale = if cfg!(target_os = "macos") {
        window.primary_monitor().ok().flatten()?.scale_factor()
    } else {
        1.0
    };
    let s = desk_scale(scale);
    Some((cursor.x / s, cursor.y / s))
}

/// Cover `area` with the window.
fn place(window: &WebviewWindow, area: Area) {
    if cfg!(target_os = "macos") {
        let _ = window.set_position(LogicalPosition::new(area.x, area.y));
        let _ = window.set_size(LogicalSize::new(area.w, area.h));
    } else {
        let _ = window.set_position(PhysicalPosition::new(area.x.round() as i32, area.y.round() as i32));
        let _ = window.set_size(PhysicalSize::new(area.w.round() as u32, area.h.round() as u32));
    }
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
        place(window, work_area(&monitor));
    }
}

/// Moving to another display: when the pointer (mid-drag of the main window)
/// is on a different monitor than the window, cover that monitor's work area
/// instead. Returns where the pointer now is inside the window, in CSS
/// pixels, so the UI can put the dragged window back under it.
pub fn follow_cursor(window: &WebviewWindow) -> Option<(f64, f64)> {
    let (x, y) = cursor(window)?;
    let monitors = window.available_monitors().ok()?;
    let target = monitors.iter().find(|m| bounds(m).contains(x, y))?;
    let current = window.current_monitor().ok().flatten();
    if current.is_some_and(|c| bounds(&c) == bounds(target)) {
        return None;
    }
    let area = work_area(target);
    place(window, area);
    // Desktop units to CSS pixels on the display the window is now on.
    let css = desk_scale(target.scale_factor()) / target.scale_factor();
    Some(((x - area.x) * css, (y - area.y) * css))
}

/// True when the pointer is over one of the UI's windows, or when that can't
/// be told (then the window should keep taking clicks).
fn pointer_over_ui(window: &WebviewWindow, state: &ClickThrough) -> bool {
    let (Some((cx, cy)), Ok(origin), Ok(scale)) =
        (cursor(window), window.inner_position(), window.scale_factor())
    else {
        return true;
    };
    let s = desk_scale(scale);
    let css = s / scale;
    let x = (cx - origin.x as f64 / s) * css;
    let y = (cy - origin.y as f64 / s) * css;
    state
        .rects
        .lock()
        .unwrap()
        .iter()
        .any(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
}

/// macOS/Windows: take the mouse only while the pointer is over one of the
/// UI's windows (or a press that began on one is still down).
///
/// The webview can't be left to say when the pointer leaves its windows: on
/// macOS it hears no mouse movement while another app is in front, and then
/// the whole transparent window would go on swallowing clicks.
pub fn start_pointer_watch(window: WebviewWindow, state: Arc<ClickThrough>) {
    std::thread::spawn(move || loop {
        let ignore = !state.held.load(Ordering::Relaxed) && !pointer_over_ui(&window, &state);
        if state.ignoring.swap(ignore, Ordering::Relaxed) != ignore {
            let _ = window.set_ignore_cursor_events(ignore);
        }
        // Quick to notice the pointer arriving; leaving can wait a moment.
        std::thread::sleep(Duration::from_millis(if ignore { 16 } else { 40 }));
    });
}

/// A press began on one of the UI's windows, or ended.
pub fn set_pointer_hold(state: &ClickThrough, held: bool) {
    state.held.store(held, Ordering::Relaxed);
}

/// Where the UI's windows are, for the pointer watch.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn areas_are_half_open() {
        let a = Area { x: 0.0, y: 0.0, w: 100.0, h: 50.0 };
        assert!(a.contains(0.0, 0.0));
        assert!(a.contains(99.9, 49.9));
        assert!(!a.contains(100.0, 10.0));
        assert!(!a.contains(10.0, 50.0));
    }

    /// A 2x laptop (1512 points wide) with a 1x display to its right: in
    /// points the two sit side by side, which their "physical" values do not.
    #[cfg(target_os = "macos")]
    #[test]
    fn mixed_scale_displays_tile_in_points() {
        let laptop = to_area(PhysicalPosition::new(0, 0), PhysicalSize::new(3024, 1964), 2.0);
        let external = to_area(PhysicalPosition::new(1512, 0), PhysicalSize::new(1920, 1080), 1.0);
        assert_eq!(laptop, Area { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 });
        assert_eq!(external, Area { x: 1512.0, y: 0.0, w: 1920.0, h: 1080.0 });
        assert!(laptop.contains(1500.0, 10.0) && !external.contains(1500.0, 10.0));
        assert!(external.contains(1600.0, 10.0) && !laptop.contains(1600.0, 10.0));
    }
}
