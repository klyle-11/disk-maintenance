//! Running `di` for the app's di window.
//!
//! di is the Python command line (backend/diskcli); the app runs the real
//! thing and streams its coloured output, so the window shows exactly what a
//! terminal would. di itself says which commands exist and which change the
//! disk (`di --app-commands`, `di --app-check`), so those rules aren't copied
//! here.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::util::home_dir;

const MAX_ARGS: usize = 32;
const MAX_ARG_LEN: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiCommand {
    pub name: String,
    pub help: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DiCheck {
    /// Why the command deletes or schedules something, if it does.
    pub destructive: Option<String>,
    /// Why the app won't run it at all (e.g. `di serve`).
    pub blocked: Option<String>,
}

/// How to start di: a Python 3.10+ and the folder holding the diskcli package.
#[derive(Debug, Clone)]
pub struct DiLauncher {
    python: Vec<OsString>,
    pythonpath: PathBuf,
}

fn python_works(candidate: &[OsString]) -> bool {
    let Some((program, args)) = candidate.split_first() else { return false };
    let mut cmd = Command::new(program);
    cmd.args(args)
        .args(["-c", "import sys; sys.exit(sys.version_info < (3, 10))"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_console(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(windows)]
fn no_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(windows))]
fn no_console(_cmd: &mut Command) {}

/// Expand `~` and `~/x` as a shell would: the window has no shell.
fn expand_tilde(arg: String) -> String {
    let sep = std::path::MAIN_SEPARATOR;
    if arg == "~" {
        return home_dir().to_string_lossy().into_owned();
    }
    if let Some(rest) = arg.strip_prefix("~/").or_else(|| arg.strip_prefix(&format!("~{sep}"))) {
        return home_dir().join(rest).to_string_lossy().into_owned();
    }
    arg
}

/// Check a command line from the window and expand `~`.
pub fn prepare_args(args: Vec<String>) -> Result<Vec<String>, String> {
    if args.len() > MAX_ARGS {
        return Err(format!("too many arguments (max {MAX_ARGS})"));
    }
    if args.iter().any(|a| a.len() > MAX_ARG_LEN) {
        return Err("argument too long".into());
    }
    if args.iter().any(|a| a.contains('\0')) {
        return Err("arguments can't contain NUL characters".into());
    }
    Ok(args.into_iter().map(expand_tilde).collect())
}

/// Turn raw bytes into text, holding back a character split across reads.
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    return out;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).expect("validated"));
                    match err.error_len() {
                        // Incomplete at the end: wait for the rest.
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                        Some(bad) => {
                            out.push('\u{fffd}');
                            self.pending.drain(..valid + bad);
                        }
                    }
                }
            }
        }
    }
}

fn stop(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        // Its own process group: this also stops anything di started.
        libc::kill(-(child.id() as i32), libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    for _ in 0..20 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl DiLauncher {
    /// Find Python and diskcli. `roots` are folders that may hold `diskcli/`
    /// (the app's bundled copy, or backend/ in a checkout). DI_PYTHON names a
    /// specific interpreter.
    pub fn find(roots: &[PathBuf]) -> Result<DiLauncher, String> {
        let pythonpath = roots
            .iter()
            .find(|r| r.join("diskcli").join("__main__.py").is_file())
            .cloned()
            .ok_or("the di package (diskcli) isn't installed with the app")?;
        let mut candidates: Vec<Vec<OsString>> = Vec::new();
        if let Some(custom) = std::env::var_os("DI_PYTHON") {
            candidates.push(custom.to_string_lossy().split_whitespace().map(OsString::from).collect());
        }
        candidates.push(vec!["python3".into()]);
        candidates.push(vec!["python".into()]);
        if cfg!(windows) {
            candidates.push(vec!["py".into(), "-3".into()]);
        }
        let python = candidates
            .into_iter()
            .find(|c| python_works(c))
            .ok_or("di needs Python 3.10 or newer on this machine (or set DI_PYTHON)")?;
        Ok(DiLauncher { python, pythonpath })
    }

    fn command(&self, columns: u16) -> Command {
        let (program, args) = self.python.split_first().expect("non-empty");
        let mut cmd = Command::new(program);
        cmd.args(args)
            .args(["-m", "diskcli"])
            .current_dir(home_dir())
            .env("PYTHONPATH", &self.pythonpath)
            .env("DI_FORCE_COLOR", "1")
            .env("COLUMNS", columns.clamp(40, 400).to_string())
            .env("LINES", "50")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("TERM", "xterm-256color")
            .env_remove("NO_COLOR")
            // Not a person at a keyboard: keeps di's pick-to-delete prompt off.
            .env_remove("DI_TTY")
            .stdin(Stdio::null());
        no_console(&mut cmd);
        cmd
    }

    fn query(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        let output = self
            .command(100)
            .args(args)
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("could not start di: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(output.stdout)
    }

    pub fn commands(&self) -> Result<Vec<DiCommand>, String> {
        #[derive(Deserialize)]
        struct Reply {
            commands: Vec<DiCommand>,
        }
        let reply: Reply = serde_json::from_slice(&self.query(&["--app-commands"])?).map_err(|e| e.to_string())?;
        Ok(reply.commands)
    }

    pub fn check(&self, args: &[String]) -> Result<DiCheck, String> {
        let mut query = vec!["--app-check"];
        query.extend(args.iter().map(String::as_str));
        serde_json::from_slice(&self.query(&query)?).map_err(|e| e.to_string())
    }

    /// Run di, passing its output (stdout and stderr together, as a terminal
    /// shows them) to `on_output` as it arrives. Stops it when `cancel` is set.
    /// Returns its exit code.
    pub fn run<F: FnMut(String)>(&self, args: &[String], columns: u16, cancel: &AtomicBool, mut on_output: F) -> Result<i32, String> {
        let (mut reader, writer) = os_pipe::pipe().map_err(|e| e.to_string())?;
        let writer2 = writer.try_clone().map_err(|e| e.to_string())?;
        let mut cmd = self.command(columns);
        cmd.args(args).stdout(writer).stderr(writer2);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| format!("could not start di: {e}"))?;
        // Close our copies of the write end, or the read end never sees EOF.
        drop(cmd);

        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(Some(buf[..n].to_vec())).is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = tx.send(None);
        });

        let mut decoder = Utf8Stream { pending: Vec::new() };
        loop {
            if cancel.load(Ordering::Relaxed) {
                stop(&mut child);
                return Err("stopped".into());
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Some(bytes)) => {
                    let text = decoder.push(&bytes);
                    if !text.is_empty() {
                        on_output(text);
                    }
                }
                Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        Ok(status.code().unwrap_or(-1))
    }
}

/// Where a checkout keeps diskcli: `backend/` next to this crate.
pub fn checkout_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("backend")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn utf8_split_across_reads_is_kept_whole() {
        let mut s = Utf8Stream { pending: Vec::new() };
        let bytes = "a█b".as_bytes();
        assert_eq!(s.push(&bytes[..2]), "a");
        assert_eq!(s.push(&bytes[2..]), "█b");
        assert_eq!(s.push(&[0xff, b'x']), "\u{fffd}x");
    }

    #[test]
    fn args_are_checked_and_tilde_expanded() {
        let home = home_dir().to_string_lossy().into_owned();
        assert_eq!(prepare_args(vec!["scan".into(), "~".into(), "a~b".into()]).unwrap(), vec!["scan".to_string(), home, "a~b".into()]);
        assert!(prepare_args(vec!["x\0".into()]).is_err());
        assert!(prepare_args(vec!["x".into(); 40]).is_err());
    }

    #[test]
    fn runs_di_from_the_checkout() {
        let Ok(di) = DiLauncher::find(&[checkout_root()]) else {
            eprintln!("no Python 3.10+ here; skipping");
            return;
        };
        assert!(di.commands().unwrap().iter().any(|c| c.name == "scan"));
        assert!(di.check(&["clean".into(), "--ye".into()]).unwrap().destructive.is_some());
        assert!(di.check(&["serve".into()]).unwrap().blocked.is_some());
        let out = Mutex::new(String::new());
        let code = di.run(&["tips".into()], 90, &AtomicBool::new(false), |t| out.lock().unwrap().push_str(&t)).unwrap();
        assert_eq!(code, 0);
        assert!(out.into_inner().unwrap().contains("\u{1b}["), "colour is forced on");
    }
}
