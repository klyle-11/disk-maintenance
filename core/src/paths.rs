//! Path rules: which system locations scans skip, and validation of paths
//! that come from the UI.

use std::path::{Component, Path, PathBuf};

/// Absolute paths skipped along with everything beneath them, matched as whole
/// path prefixes ("/Library" skips /Library but not ~/Library).
#[cfg(windows)]
const IGNORE_PREFIXES: &[&str] = &[
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
];
#[cfg(target_os = "macos")]
const IGNORE_PREFIXES: &[&str] = &["/System", "/Applications", "/Library", "/Users/Shared", "/private"];
#[cfg(target_os = "linux")]
const IGNORE_PREFIXES: &[&str] = &["/usr", "/bin", "/sbin", "/lib", "/lib64", "/var", "/etc", "/proc", "/sys", "/dev"];
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
const IGNORE_PREFIXES: &[&str] = &[];

/// Folder names skipped wherever they appear (compared case-insensitively).
const IGNORE_NAMES: &[&str] = &["$Recycle.Bin", "System Volume Information", "RECYCLER"];
#[cfg(target_os = "macos")]
const IGNORE_NAMES_OS: &[&str] = &[".Trashes", ".fseventsd", ".Spotlight-V100", ".DocumentRevisions-V100"];
#[cfg(not(target_os = "macos"))]
const IGNORE_NAMES_OS: &[&str] = &[];

/// macOS and Windows file systems are case-insensitive by default.
const CASE_INSENSITIVE_FS: bool = cfg!(any(windows, target_os = "macos"));

fn fold(path: &str) -> String {
    let p = path.replace('\\', "/");
    let p = p.trim_end_matches('/');
    if CASE_INSENSITIVE_FS {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

/// True if `path` is an ignored system location or an ignored folder name.
pub fn should_ignore(path: &Path) -> bool {
    let folded = fold(&path.to_string_lossy());
    let name = folded.rsplit('/').next().unwrap_or("").to_lowercase();
    if IGNORE_NAMES.iter().chain(IGNORE_NAMES_OS).any(|n| n.to_lowercase() == name) {
        return true;
    }
    IGNORE_PREFIXES.iter().any(|prefix| {
        let prefix = fold(prefix);
        folded == prefix || folded.starts_with(&(prefix + "/"))
    })
}

const MAX_PATH_LENGTH: usize = 1000;

/// Validate a directory path typed or picked in the UI and return it
/// canonicalized. Any existing directory is allowed, on any drive (including
/// external drives plugged in after launch); only malformed input, `..`
/// traversal and paths that are not directories are refused.
pub fn validate_dir(input: &str) -> Result<PathBuf, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Invalid path: Path is empty".into());
    }
    if trimmed.len() > MAX_PATH_LENGTH {
        return Err(format!("Invalid path: Path too long (max {MAX_PATH_LENGTH} characters)"));
    }
    if trimmed.contains('\0') {
        return Err("Invalid path: Null bytes not allowed in paths".into());
    }
    let expanded = expand_home(trimmed);
    if expanded.components().any(|c| c == Component::ParentDir) {
        return Err("Invalid path: Path contains a '..' component".into());
    }
    let canonical = dunce::canonicalize(&expanded)
        .map_err(|_| format!("Path does not exist: {}", expanded.display()))?;
    if !canonical.is_dir() {
        return Err(format!("Path is not a directory: {}", canonical.display()));
    }
    Ok(canonical)
}

/// `~` and `~/...` relative to the home folder; everything else unchanged.
/// A bare drive letter ("D:") means the drive's root, not its current folder.
fn expand_home(input: &str) -> PathBuf {
    if input == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(input));
    }
    if let Some(rest) = input.strip_prefix("~/").or_else(|| input.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if cfg!(windows) && input.len() == 2 && input.ends_with(':') {
        return PathBuf::from(format!("{input}\\"));
    }
    PathBuf::from(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_names_anywhere() {
        assert!(should_ignore(Path::new("/x/System Volume Information")));
        assert!(should_ignore(Path::new("/x/$RECYCLE.BIN")));
        assert!(!should_ignore(Path::new("/x/recycler-notes")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ignores_prefixes_not_substrings() {
        assert!(should_ignore(Path::new("/usr")));
        assert!(should_ignore(Path::new("/usr/lib")));
        assert!(!should_ignore(Path::new("/home/me/usr")));
        assert!(!should_ignore(Path::new("/usrlocal")));
    }

    #[test]
    fn validates_directories() {
        let dir = tempfile::tempdir().unwrap();
        let ok = validate_dir(dir.path().to_str().unwrap()).unwrap();
        assert!(ok.is_dir());

        let file = dir.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(validate_dir(file.to_str().unwrap()).unwrap_err().contains("not a directory"));
        assert!(validate_dir(dir.path().join("nope").to_str().unwrap())
            .unwrap_err()
            .contains("does not exist"));
        let traversal = format!("{}/../etc", dir.path().display());
        assert!(validate_dir(&traversal).unwrap_err().contains(".."));
        assert!(validate_dir("").is_err());
        assert!(validate_dir("a\0b").is_err());
    }

    #[test]
    fn dots_inside_a_name_are_fine() {
        let dir = tempfile::tempdir().unwrap();
        let odd = dir.path().join("release..v2");
        std::fs::create_dir(&odd).unwrap();
        assert!(validate_dir(odd.to_str().unwrap()).is_ok());
    }
}
