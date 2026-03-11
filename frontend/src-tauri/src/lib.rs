mod database;
mod models;
mod repository;
mod scanner;
mod commands;

// Import command functions for use in generate_handler
use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Initialize database
      database::establish_connection(app.handle())
        .expect("Failed to initialize database");

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        // Snapshot commands
        get_snapshots,
        get_snapshot,
        save_snapshot,
        update_snapshot,
        delete_snapshot,

        // Scan commands
        scan_directory,
        scan_directory_with_progress,
        get_findings,
        get_extension_summary,

        // Comparison commands
        compare_directories,
        save_comparison_snapshot,

        // Health check
        health_check,

        // Du-hast-much commands
        run_du_hast_much,

        // Dialog commands
        select_directory,

        // Utility commands
        format_bytes,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
