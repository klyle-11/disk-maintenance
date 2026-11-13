//! Disk Intelligence core.
//!
//! Everything the desktop app does lives here, so the Tauri shell only maps
//! commands onto [`service::Service`]. The JSON shapes match the old FastAPI
//! backend (snake_case), so the frontend's transforms work unchanged.

pub mod analyzer;
pub mod archives;
pub mod caches;
pub mod catalog;
pub mod compare;
pub mod di;
pub mod disks;
pub mod drive_catalog;
pub mod drives;
pub mod duhast;
pub mod model;
pub mod offload;
pub mod offload_service;
pub mod paths;
pub mod scanner;
pub mod service;
pub mod snapshots;
pub mod tips;
pub mod util;

pub use service::Service;
