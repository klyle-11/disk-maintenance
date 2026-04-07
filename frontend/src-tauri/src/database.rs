// Database module for Disk Intelligence
// Handles SQLite database operations for snapshots

use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use anyhow::Result;

// Embed migrations
pub const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

// Database file path
pub fn get_db_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir()
        .expect("Failed to get app data dir")
        .join("disk_intelligence.db")
}

// Establish database connection
pub fn establish_connection(app: &AppHandle) -> Result<SqliteConnection> {
    let db_path = get_db_path(app);

    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let database_url = db_path.to_string_lossy().to_string();
    let mut conn = SqliteConnection::establish(&database_url)
        .map_err(|e| anyhow::anyhow!("Failed to connect to database: {}", e))?;

    // Run migrations
    conn.run_pending_migrations(MIGRATIONS)
        .map_err(|e| anyhow::anyhow!("Failed to run migrations: {}", e))?;

    Ok(conn)
}

// Database models will be defined here
// This module will contain the snapshot CRUD operations