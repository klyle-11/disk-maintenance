//! Disk Intelligence core: everything the desktop app does with the disk,
//! as a library the Tauri app calls directly (no server, no ports).
//!
//! - [`scan`]: a parallel walk with per-folder totals
//! - [`analyze`]: findings and the file-type summary
//! - [`compare`]: two trees side by side
//! - [`dhm`]: du-hast-much, folder sizes as they finish
//! - [`store`]: saved snapshots, in the database `di` shares
//! - [`tips`]: keeping freed space free
//! - [`di`]: running the `di` command line

pub mod analyze;
pub mod compare;
pub mod dhm;
pub mod di;
pub mod scan;
pub mod store;
pub mod tips;
pub mod util;
