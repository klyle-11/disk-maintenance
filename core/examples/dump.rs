//! Print what the core finds, as JSON, to compare against other tools.
//!
//!   cargo run -p diskcore --release --example dump -- scan <folder>
//!   cargo run -p diskcore --release --example dump -- compare <source> <target> [--deep]
//!   cargo run -p diskcore --release --example dump -- dhm <folder>

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use diskcore::{analyze, compare, dhm, scan};
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let start = Instant::now();
    let out = match args.first().map(String::as_str) {
        Some("scan") => {
            let data = scan::scan(Path::new(&args[1]), &scan::Progress::default(), &AtomicBool::new(false)).expect("not cancelled");
            json!({
                "total_files": data.total_files,
                "total_size": data.total_size,
                "folders": data.folders.iter().map(|f| json!([f.path, f.total_size, f.file_count])).collect::<Vec<_>>(),
                "findings": analyze::analyze(&data),
                "extensions": analyze::extension_summary(&data),
            })
        }
        Some("compare") => {
            let (tree, summary) = compare::compare(Path::new(&args[1]), Path::new(&args[2]), args.get(3).map(|a| a == "--deep").unwrap_or(false));
            json!({ "summary": summary, "tree": tree })
        }
        Some("dhm") => json!(dhm::scan(Path::new(&args[1]), &[], &AtomicBool::new(false), |_| {})),
        _ => {
            eprintln!("usage: dump scan <folder> | compare <a> <b> [--deep] | dhm <folder>");
            std::process::exit(2);
        }
    };
    eprintln!("{:.2}s", start.elapsed().as_secs_f64());
    println!("{out}");
}
