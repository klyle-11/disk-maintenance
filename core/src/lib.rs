//! Disk Intelligence core.
//!
//! Everything the desktop app does lives here, so the Tauri shell only maps
//! commands onto [`service::Service`]. The JSON shapes match the old FastAPI
//! backend (snake_case), so the frontend's transforms work unchanged.

pub mod analyzer;
pub mod compare;
pub mod duhast;
pub mod model;
pub mod paths;
pub mod scanner;
pub mod service;
pub mod snapshots;
pub mod tips;
pub mod util;

pub use service::Service;
