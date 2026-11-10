//! Clearing caches: the "Clear caches" button in the di window.
//!
//! macOS does what the old `Clear caches.command` script did (system and user
//! caches, /var/log, /Library/Updates, Qobuz's tmp folder), with the home
//! folder looked up instead of written in. Windows clears the closest
//! equivalents: the user's and the system's temp folders, the Windows Update
//! download cache, and Qobuz's tmp folder. Only what is inside each folder is
//! removed; the folders themselves stay.
//!
//! Some of these need an administrator, so the deleting runs elevated: macOS
//! asks for the password through `osascript ... with administrator
//! privileges`, Windows through the UAC prompt (`Start-Process -Verb RunAs`).
//! Files in use or protected by the system are skipped and counted.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

#[cfg(any(target_os = "macos", windows))]
use crate::util::home_dir;

/// Whether this OS has a cache clear.
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CacheTarget {
    /// What the folder is, for people.
    pub label: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TargetResult {
    pub label: String,
    pub path: PathBuf,
    /// Bytes readable before and after (folders the app can't read count as 0).
    pub before: u64,
    pub after: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClearReport {
    pub targets: Vec<TargetResult>,
    pub freed: u64,
    /// Items the OS wouldn't let go of (in use, or protected).
    pub skipped: u64,
}

#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn target(label: &str, path: PathBuf) -> CacheTarget {
    CacheTarget { label: label.to_string(), path }
}

/// The folders this OS's clear empties, those that exist.
pub fn targets() -> Vec<CacheTarget> {
    #[allow(unused_mut)]
    let mut all: Vec<CacheTarget> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let home = home_dir();
        all.push(target("System caches", PathBuf::from("/Library/Caches")));
        all.push(target("Your caches", home.join("Library/Caches")));
        all.push(target("System logs", PathBuf::from("/var/log")));
        all.push(target("Downloaded updates", PathBuf::from("/Library/Updates")));
        all.push(target("Qobuz tmp", home.join("Library/Application Support/Qobuz/tmp")));
    }
    #[cfg(windows)]
    {
        let windir = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("windir"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        all.push(target("Your temp files", std::env::temp_dir()));
        all.push(target("System temp files", windir.join("Temp")));
        all.push(target("Windows Update downloads", windir.join("SoftwareDistribution").join("Download")));
        let home = home_dir();
        let roaming = dirs::data_dir().unwrap_or_else(|| home.join("AppData\\Roaming"));
        let local = dirs::data_local_dir().unwrap_or_else(|| home.join("AppData\\Local"));
        all.push(target("Qobuz tmp", roaming.join("Qobuz").join("tmp")));
        all.push(target("Qobuz tmp", local.join("Qobuz").join("tmp")));
    }
    all.retain(|t| t.path.is_dir());
    all.dedup_by(|a, b| a.path == b.path);
    all
}

/// Bytes under `path` that can be read, without following links.
pub fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => dir_size(&entry.path()),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// A word the shell takes literally.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A string AppleScript takes literally.
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// A string PowerShell takes literally.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The shell script run as root on macOS. Every folder is emptied even if an
/// earlier one fails; each item that can't go prints a line with SKIPPED.
pub fn mac_script(paths: &[PathBuf]) -> String {
    let mut script = String::new();
    for path in paths {
        let q = sh_quote(&path.to_string_lossy());
        script.push_str(&format!(
            "find {q} -mindepth 1 -maxdepth 1 -exec rm -rf {{}} + 2>&1 | sed 's/^/SKIPPED /'\n"
        ));
    }
    script.push_str("exit 0\n");
    script
}

/// The `osascript` arguments that run `script` as an administrator.
pub fn mac_osascript_args(script: &str) -> Vec<String> {
    vec![
        "-e".into(),
        format!(
            "do shell script {} with prompt {} with administrator privileges without altering line endings",
            applescript_string(script),
            applescript_string("Disk Intelligence wants to clear caches.")
        ),
    ]
}

/// The PowerShell script run elevated on Windows. Writes one line per folder
/// to `log`: the folder and how many items in it couldn't be removed.
pub fn windows_script(paths: &[PathBuf], log: &Path) -> String {
    let dirs: Vec<String> = paths.iter().map(|p| ps_quote(&p.to_string_lossy())).collect();
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$out = @()
$wu = Get-Service -Name wuauserv
$wasRunning = $wu -and $wu.Status -eq 'Running'
if ($wasRunning) {{ Stop-Service -Name wuauserv -Force }}
foreach ($d in @({dirs})) {{
  $skipped = 0
  if (Test-Path -LiteralPath $d) {{
    Get-ChildItem -LiteralPath $d -Force | ForEach-Object {{
      try {{ Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop }} catch {{ $skipped++ }}
    }}
  }}
  $out += "$skipped`t$d"
}}
if ($wasRunning) {{ Start-Service -Name wuauserv }}
$out | Out-File -LiteralPath {log} -Encoding utf8
"#,
        dirs = dirs.join(", "),
        log = ps_quote(&log.to_string_lossy()),
    )
}

/// For `powershell -EncodedCommand`: base64 of the UTF-16LE text.
pub fn powershell_encode(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64(&bytes)
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The `powershell` arguments that run `script` elevated, waiting for it.
/// Exits 1223 (ERROR_CANCELLED) when the UAC prompt is declined.
pub fn windows_launch_args(script: &str) -> Vec<String> {
    let inner = format!("'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{}'", powershell_encode(script));
    vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-Command".into(),
        format!(
            "try {{ Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList {inner} -ErrorAction Stop }} catch {{ exit 1223 }}"
        ),
    ]
}

#[cfg(windows)]
fn no_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
#[cfg(not(windows))]
fn no_console(_cmd: &mut Command) {}

#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
fn run(program: &str, args: &[String]) -> Result<(i32, String, String), String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("Couldn't start {program}: {e}"))?;
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// Empty `targets` as an administrator. Ok(skipped) is how many items stayed;
/// Err("cancelled") when the password or UAC prompt was dismissed.
#[cfg(target_os = "macos")]
fn clear_elevated(targets: &[CacheTarget], on_line: &mut dyn FnMut(String)) -> Result<u64, String> {
    let paths: Vec<PathBuf> = targets.iter().map(|t| t.path.clone()).collect();
    let (code, stdout, stderr) = run("/usr/bin/osascript", &mac_osascript_args(&mac_script(&paths)))?;
    if code != 0 {
        if stderr.contains("-128") || stderr.contains("User canceled") {
            return Err("cancelled".into());
        }
        return Err(format!("osascript failed: {}", stderr.trim()));
    }
    let skipped: Vec<&str> = stdout.lines().filter(|l| l.starts_with("SKIPPED ")).collect();
    for line in skipped.iter().take(5) {
        on_line(format!("  {}", line.trim_start_matches("SKIPPED ")));
    }
    if skipped.len() > 5 {
        on_line(format!("  …and {} more", skipped.len() - 5));
    }
    Ok(skipped.len() as u64)
}

#[cfg(windows)]
fn clear_elevated(targets: &[CacheTarget], _on_line: &mut dyn FnMut(String)) -> Result<u64, String> {
    let paths: Vec<PathBuf> = targets.iter().map(|t| t.path.clone()).collect();
    let log = std::env::temp_dir().join(format!("disk-intelligence-clear-{}.log", uuid::Uuid::new_v4().simple()));
    let (code, _stdout, stderr) = run("powershell.exe", &windows_launch_args(&windows_script(&paths, &log)))?;
    if code == 1223 {
        return Err("cancelled".into());
    }
    if code != 0 {
        return Err(format!("PowerShell failed: {}", stderr.trim()));
    }
    let text = std::fs::read_to_string(&log).unwrap_or_default();
    let _ = std::fs::remove_file(&log);
    Ok(text
        .lines()
        .filter_map(|l| l.trim_start_matches('\u{feff}').split('\t').next()?.trim().parse::<u64>().ok())
        .sum())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn clear_elevated(_targets: &[CacheTarget], _on_line: &mut dyn FnMut(String)) -> Result<u64, String> {
    Err("Clearing caches is only for macOS and Windows".into())
}

/// Clear this OS's caches, reporting progress a line at a time.
pub fn clear(mut on_line: impl FnMut(String)) -> Result<ClearReport, String> {
    if !SUPPORTED {
        return Err("Clearing caches is only for macOS and Windows".into());
    }
    let targets = targets();
    if targets.is_empty() {
        return Err("No cache folders found".into());
    }
    on_line("measuring…".into());
    let before: Vec<u64> = targets.iter().map(|t| dir_size(&t.path)).collect();
    on_line("waiting for permission…".into());
    let skipped = clear_elevated(&targets, &mut on_line)?;
    let results: Vec<TargetResult> = targets
        .iter()
        .zip(before)
        .map(|(t, before)| TargetResult { label: t.label.clone(), path: t.path.clone(), before, after: dir_size(&t.path) })
        .collect();
    let freed = results.iter().map(|r| r.before.saturating_sub(r.after)).sum();
    Ok(ClearReport { targets: results, freed, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // PowerShell's own: [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('dir'))
        assert_eq!(powershell_encode("dir"), "ZABpAHIA");
    }

    #[test]
    fn mac_script_quotes_paths() {
        let script = mac_script(&[PathBuf::from("/Users/o'neil/Library/Application Support/Qobuz/tmp")]);
        assert!(script.contains("find '/Users/o'\\''neil/Library/Application Support/Qobuz/tmp' -mindepth 1"));
        let args = mac_osascript_args("echo \"hi\" \\ there");
        assert!(args[1].starts_with("do shell script \"echo \\\"hi\\\" \\\\ there\""));
        assert!(args[1].contains("with administrator privileges"));
    }

    #[cfg(unix)]
    #[test]
    fn mac_script_empties_folders_and_keeps_them() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("it's caches");
        std::fs::create_dir_all(a.join("sub/deeper")).unwrap();
        std::fs::write(a.join("sub/deeper/f"), b"12345").unwrap();
        std::fs::write(a.join(".hidden"), b"1").unwrap();
        std::fs::write(a.join("plain"), b"1").unwrap();
        let missing = dir.path().join("missing");
        let out = Command::new("sh").arg("-c").arg(mac_script(&[a.clone(), missing])).output().unwrap();
        assert!(out.status.success());
        assert!(a.is_dir());
        assert_eq!(std::fs::read_dir(&a).unwrap().count(), 0);
        // A missing folder is reported, not fatal.
        assert!(String::from_utf8_lossy(&out.stdout).contains("SKIPPED"));
    }

    #[test]
    fn windows_script_quotes_paths() {
        let script = windows_script(&[PathBuf::from("C:\\Users\\o'neil\\AppData\\Local\\Temp")], Path::new("C:\\t\\x.log"));
        assert!(script.contains("@('C:\\Users\\o''neil\\AppData\\Local\\Temp')"));
        assert!(script.contains("Out-File -LiteralPath 'C:\\t\\x.log'"));
        let args = windows_launch_args(&script);
        assert!(args[3].contains("-Verb RunAs -Wait"));
        assert!(!args[3].contains("o'neil"));
    }

    #[test]
    fn dir_size_counts_files_under_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("a/b/f"), b"12345").unwrap();
        std::fs::write(dir.path().join("g"), b"12").unwrap();
        assert_eq!(dir_size(dir.path()), 7);
        assert_eq!(dir_size(&dir.path().join("nope")), 0);
    }
}
