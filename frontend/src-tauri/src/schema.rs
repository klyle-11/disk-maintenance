// @generated automatically by Diesel CLI.

diesel::table! {
    snapshots (id) {
        id -> Text,
        scan_id -> Text,
        root_path -> Text,
        findings_json -> Text,
        extensions_json -> Text,
        scan_info_json -> Text,
        saved_at -> Text,
        total_files -> Nullable<Integer>,
        total_folders -> Nullable<Integer>,
        total_size_bytes -> Nullable<Integer>,
        snapshot_type -> Text,
        target_path -> Nullable<Text>,
        comparison_json -> Nullable<Text>,
        comparison_summary_json -> Nullable<Text>,
    }
}
