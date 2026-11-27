//! Finding a Python for `di`, and setting one up when the machine has none.
//!
//! `di` is Python 3.10+. The app looks for one the way a person would
//! (`DI_PYTHON`, the usual commands, and the places installers put Python
//! that an app started from the Finder or Start menu can't see on its
//! PATH). If there is none, it downloads a self-contained CPython build from
//! the python-build-standalone project once, checks it against the SHA-256
//! pinned below, and unpacks it into the app's own data folder. Nothing is
//! installed system-wide, nothing needs an administrator, and deleting that
//! folder undoes it.

use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// The python-build-standalone release and CPython version the app sets up.
const RELEASE: &str = "20261110";
const VERSION: &str = "3.13.18";

/// (target triple, SHA-256 of its `install_only_stripped` archive), from the
/// release's SHA256SUMS.
const BUILDS: &[(&str, &str)] = &[
    (
        "x86_64-pc-windows-msvc",
        "2e0fed09d48989f64c9305da9ff2d37a41c0d13ab2aa6283405b2b620dfbf805",
    ),
    (
        "aarch64-pc-windows-msvc",
        "0a8840071810ddb8565256cd406b466d4e9dc6dc523395a5477880dbc4f67eb3",
    ),
    (
        "aarch64-apple-darwin",
        "7a2384641584ab9984221fcb0fc9265df465922af71be71410529e2a9c3f0540",
    ),
    (
        "x86_64-apple-darwin",
        "d27d59a722db9f69926eb6d9564071247221f45a04da920ea7f3001c97e32f9b",
    ),
    (
        "x86_64-unknown-linux-gnu",
        "f2d2199eb25880e07863b391cf7124e7ffa1338b0d65600dfcec117c4223a7fb",
    ),
    (
        "aarch64-unknown-linux-gnu",
        "55c00325f7c1fddf325dfc621aabdfbbac4dc54adda224af88ec411dc12db239",
    ),
];

/// This machine's build: (triple, sha256), or None where there is none.
fn build_for_this_machine() -> Option<(&'static str, &'static str)> {
    let os = if cfg!(windows) {
        "pc-windows-msvc"
    } else if cfg!(target_os = "macos") {
        "apple-darwin"
    } else if cfg!(all(target_os = "linux", target_env = "gnu")) {
        "unknown-linux-gnu"
    } else {
        return None;
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        return None;
    };
    let triple = format!("{arch}-{os}");
    BUILDS.iter().copied().find(|(t, _)| *t == triple)
}

fn archive_name(triple: &str) -> String {
    format!("cpython-{VERSION}+{RELEASE}-{triple}-install_only_stripped.tar.gz")
}

fn download_url(triple: &str) -> String {
    format!(
        "https://github.com/astral-sh/python-build-standalone/releases/download/{RELEASE}/{}",
        archive_name(triple)
    )
}

/// Where the app keeps the Python it set up: `<local data>/DiskIntelligence/python`
/// (%LOCALAPPDATA% on Windows, ~/Library/Application Support on macOS,
/// ~/.local/share on Linux).
pub fn default_home() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("DiskIntelligence").join("python"))
}

/// The unpacked build's interpreter under `home`.
fn managed_python(home: &Path) -> PathBuf {
    let root = home
        .join(format!("cpython-{VERSION}+{RELEASE}"))
        .join("python");
    if cfg!(windows) {
        root.join("python.exe")
    } else {
        root.join("bin").join("python3")
    }
}

pub(crate) fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Does this command start a Python 3.10 or newer?
fn is_python310(candidate: &[OsString]) -> bool {
    let mut cmd = Command::new(&candidate[0]);
    cmd.args(&candidate[1..])
        .args(["-c", "import sys; sys.exit(sys.version_info < (3, 10))"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd).status().is_ok_and(|s| s.success())
}

/// Folders matching `pattern*` inside `dir`, newest name first.
fn versions_in(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .map(|e| e.path())
        .collect();
    // "Python313" > "Python39" by number, not by text.
    found.sort_by_key(|p| {
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        let digits: String = name.chars().filter(|c| c.is_ascii_digit()).collect();
        std::cmp::Reverse(
            digits
                .get(1..)
                .and_then(|d| d.parse::<u32>().ok())
                .unwrap_or(0),
        )
    });
    found
}

/// Where Python installers put it, for apps that don't inherit a shell's PATH.
fn known_locations() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        let mut roots = Vec::new();
        if let Some(local) = dirs::data_local_dir() {
            roots.push(local.join("Programs").join("Python"));
        }
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(p) = std::env::var_os(var) {
                roots.push(PathBuf::from(p));
            }
        }
        roots.push(PathBuf::from("C:\\"));
        for root in roots {
            for dir in versions_in(&root, "Python3") {
                out.push(dir.join("python.exe"));
            }
        }
    } else if cfg!(target_os = "macos") {
        out.push("/opt/homebrew/bin/python3".into());
        out.push("/usr/local/bin/python3".into());
        let framework = Path::new("/Library/Frameworks/Python.framework/Versions");
        for dir in versions_in(framework, "3.") {
            out.push(dir.join("bin").join("python3"));
        }
    } else {
        out.push("/usr/local/bin/python3".into());
        out.push("/usr/bin/python3".into());
    }
    out
}

/// A Python 3.10+ that is already on this machine (or set up by the app
/// under `home`), as the command to start it.
pub fn find(home: Option<&Path>) -> Option<Vec<OsString>> {
    if let Some(py) = std::env::var_os("DI_PYTHON").filter(|p| !p.is_empty()) {
        return Some(vec![py]);
    }
    if let Some(home) = home {
        let managed = managed_python(home);
        if managed.is_file() && is_python310(&[managed.clone().into()]) {
            return Some(vec![managed.into()]);
        }
    }
    let on_path: &[&[&str]] = if cfg!(windows) {
        &[&["py", "-3"], &["python"], &["python3"]]
    } else {
        &[&["python3"], &["python"]]
    };
    for candidate in on_path {
        // macOS's /usr/bin/python3 is a stub that offers to install Apple's
        // developer tools (whose Python is 3.9 anyway): never start it.
        if cfg!(target_os = "macos")
            && which::which(candidate[0]).is_ok_and(|p| p.starts_with("/usr/bin"))
        {
            continue;
        }
        let candidate: Vec<OsString> = candidate.iter().map(OsString::from).collect();
        if is_python310(&candidate) {
            return Some(candidate);
        }
    }
    known_locations()
        .into_iter()
        .filter(|p| p.is_file())
        .map(|p| vec![p.into_os_string()])
        .find(|c| is_python310(c))
}

/// Download, check and unpack this machine's Python build under `home`, and
/// return the command to start it. `progress` gets short lines to show the
/// person waiting. Safe to call when it is already there.
pub fn install(home: &Path, mut progress: impl FnMut(&str)) -> Result<Vec<OsString>, String> {
    let python = managed_python(home);
    if python.is_file() && is_python310(&[python.clone().into()]) {
        return Ok(vec![python.into()]);
    }
    let (triple, sha256) = build_for_this_machine().ok_or_else(|| {
        "di needs Python 3.10 or newer. None was found, and there is no ready-made \
         Python to set up for this kind of computer: install one, or set DI_PYTHON \
         to its path."
            .to_string()
    })?;
    fs::create_dir_all(home).map_err(|e| format!("could not create {}: {e}", home.display()))?;

    let url = download_url(triple);
    progress(&format!(
        "No Python 3.10+ found, so di is setting up its own (Python {VERSION}, one time)."
    ));
    let archive = home.join(format!("{}.part", archive_name(triple)));
    let result = download(&agent(true), &url, &archive, sha256, &mut progress)
        .and_then(|()| unpack(&archive, home, &mut progress));
    let _ = fs::remove_file(&archive);
    result.map_err(|e| {
        format!(
            "{e}. di needs Python 3.10 or newer: connect to the internet and try again, \
             or install Python from python.org (or set DI_PYTHON to its path)."
        )
    })?;

    if !is_python310(&[python.clone().into()]) {
        return Err(format!(
            "the Python set up in {} does not start",
            home.display()
        ));
    }
    progress(&format!("Python {VERSION} is ready for di."));
    Ok(vec![python.into()])
}

/// An HTTP client that goes through the proxy set in HTTPS_PROXY / ALL_PROXY,
/// if any, and trusts the system's certificates (so company proxies work).
fn agent(proxy_from_env: bool) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .try_proxy_from_env(proxy_from_env)
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .build()
}

fn download(
    agent: &ureq::Agent,
    url: &str,
    to: &Path,
    sha256: &str,
    progress: &mut impl FnMut(&str),
) -> Result<(), String> {
    let response = agent
        .get(url)
        .call()
        .map_err(|e| format!("could not download Python ({e})"))?;
    let total: Option<u64> = response
        .header("Content-Length")
        .and_then(|v| v.parse().ok());
    progress(&match total {
        Some(n) => format!("Downloading {:.0} MB…", n as f64 / 1_048_576.0),
        None => "Downloading…".to_string(),
    });

    let mut reader = response.into_reader();
    let mut file =
        fs::File::create(to).map_err(|e| format!("could not write {}: {e}", to.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut next_report = 25;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("the Python download was cut off ({e})"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n])
            .map_err(|e| format!("could not write {}: {e}", to.display()))?;
        done += n as u64;
        if let Some(total) = total.filter(|t| *t > 0) {
            let pct = done * 100 / total;
            if pct >= next_report && pct < 100 {
                progress(&format!("  {pct}%"));
                next_report += 25;
            }
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    let got = format!("{:x}", hasher.finalize());
    if got != sha256 {
        return Err("the downloaded Python did not match its checksum, so it was not used".into());
    }
    Ok(())
}

/// Unpack the archive's `python/` folder to `<home>/cpython-<version>+<release>`.
fn unpack(archive: &Path, home: &Path, progress: &mut impl FnMut(&str)) -> Result<(), String> {
    progress("Unpacking…");
    let target = home.join(format!("cpython-{VERSION}+{RELEASE}"));
    let staging = home.join(format!(".unpacking-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    let unpacked = (|| -> io::Result<()> {
        let file = fs::File::open(archive)?;
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        tar.set_preserve_permissions(true);
        // `unpack` refuses entries that would land outside `staging`.
        tar.unpack(&staging)
    })();
    if let Err(e) = unpacked {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("could not unpack the Python download ({e})"));
    }
    let _ = fs::remove_dir_all(&target);
    fs::rename(&staging, &target).map_err(|e| {
        let _ = fs::remove_dir_all(&staging);
        format!("could not move Python into {} ({e})", target.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_build_has_a_full_checksum() {
        for (triple, sha) in BUILDS {
            assert_eq!(sha.len(), 64, "{triple}");
            assert!(sha.chars().all(|c| c.is_ascii_hexdigit()), "{triple}");
        }
        assert!(download_url("x86_64-pc-windows-msvc").ends_with(
            "/20261110/cpython-3.13.18+20261110-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
        ));
    }

    #[test]
    fn this_machine_has_a_build() {
        // CI builds the app for these; each one needs a Python to set up.
        if cfg!(any(windows, target_os = "macos", target_os = "linux")) {
            assert!(build_for_this_machine().is_some());
        }
    }

    #[test]
    fn newest_windows_python_folder_first() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["Python39", "Python313", "Python311", "Other"] {
            fs::create_dir(dir.path().join(name)).unwrap();
        }
        let names: Vec<_> = versions_in(dir.path(), "Python3")
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["Python313", "Python311", "Python39"]);
    }

    #[test]
    fn a_bad_checksum_is_refused_and_nothing_is_unpacked() {
        // A tiny local server stands in for GitHub.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut req = [0u8; 1024];
                let _ = s.read(&mut req);
                let body = b"not python";
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(body);
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let to = dir.path().join("x.part");
        let err = download(
            &agent(false),
            &format!("http://127.0.0.1:{port}/x"),
            &to,
            BUILDS[0].1,
            &mut |_| {},
        )
        .unwrap_err();
        assert!(err.contains("checksum"), "{err}");
    }

    #[test]
    fn unpacks_the_python_folder() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("py.tar.gz");
        {
            let gz = flate2::write::GzEncoder::new(
                fs::File::create(&archive).unwrap(),
                flate2::Compression::fast(),
            );
            let mut tar = tar::Builder::new(gz);
            let data = b"#!/bin/sh\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append_data(&mut header, "python/bin/python3", &data[..])
                .unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }
        let home = dir.path().join("home");
        fs::create_dir(&home).unwrap();
        unpack(&archive, &home, &mut |_| {}).unwrap();
        assert!(home
            .join(format!("cpython-{VERSION}+{RELEASE}/python/bin/python3"))
            .is_file());
    }
}
