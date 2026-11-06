//! Run the `di` command line for the app's di window.
//!
//! `di` is Python (backend/diskcli). Each run is a `python -m diskcli`
//! subprocess whose coloured output is streamed back as it arrives, so the
//! window shows exactly what `di` prints in a terminal. Which commands exist
//! and which ones change the disk is decided by di's own parser, through
//! `python -m diskcli.app_bridge`, the same code the Electron backend uses.
//!
//! The app bundles diskcli's sources; it needs a Python 3.10+ on the machine
//! (found like the `di` launchers do, or set with `DI_PYTHON`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const MAX_LIVE_RUNS: usize = 4;

/// One message from a running command.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DiEvent {
    /// Output, stdout and stderr together as a terminal shows them.
    Out { data: String },
    /// The last message of every run.
    Exit { code: i32, elapsed: f64 },
}

/// What the bridge says about a command line.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiCheck {
    /// The arguments as di gets them (`~` expanded).
    pub argv: Vec<String>,
    /// Why the command changes the disk, if it does; the app asks first.
    pub needs_confirm: Option<String>,
}

#[derive(Default)]
struct Live {
    /// Request id -> process id. `None` marks a run stopped before it started.
    runs: HashMap<String, Option<u32>>,
}

pub struct DiRunner {
    /// The folder holding the `diskcli` package (PYTHONPATH).
    root: PathBuf,
    python: OnceLock<Result<Vec<OsString>, String>>,
    live: Mutex<Live>,
}

fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The Python to run di with: `DI_PYTHON`, else the first of the usual
/// names that is really Python 3.10+ (on Windows, `python` can be a Store stub).
fn find_python() -> Result<Vec<OsString>, String> {
    if let Some(py) = std::env::var_os("DI_PYTHON").filter(|p| !p.is_empty()) {
        return Ok(vec![py]);
    }
    let candidates: &[&[&str]] = if cfg!(windows) {
        &[&["py", "-3"], &["python"], &["python3"]]
    } else {
        &[&["python3"], &["python"]]
    };
    for candidate in candidates {
        let mut cmd = Command::new(candidate[0]);
        cmd.args(&candidate[1..])
            .args(["-c", "import sys; sys.exit(sys.version_info < (3, 10))"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if no_window(&mut cmd).status().is_ok_and(|s| s.success()) {
            return Ok(candidate.iter().map(OsString::from).collect());
        }
    }
    Err(
        "di needs Python 3.10 or newer, and none was found. Install it from python.org, \
         or set DI_PYTHON to its path, then restart the app."
            .into(),
    )
}

/// Move the complete UTF-8 text out of `buf`, keeping a character cut in half
/// at the end for the next chunk. Invalid bytes become U+FFFD.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(buf) {
            Ok(text) => {
                out.push_str(text);
                buf.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&buf[..valid]).expect("valid prefix"));
                match e.error_len() {
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        buf.drain(..valid + bad);
                    }
                    None => {
                        buf.drain(..valid);
                        return out;
                    }
                }
            }
        }
    }
}

fn stop_process(pid: u32) {
    #[cfg(unix)]
    unsafe {
        // di runs in its own process group: stop it and anything it started.
        libc::killpg(pid as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = no_window(&mut cmd).status();
    }
}

impl DiRunner {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        DiRunner {
            root: root.into(),
            python: OnceLock::new(),
            live: Mutex::new(Live::default()),
        }
    }

    fn python_command(&self) -> Result<Command, String> {
        let py = self.python.get_or_init(find_python).clone()?;
        let mut cmd = Command::new(&py[0]);
        cmd.args(&py[1..]);
        let mut path = OsString::from(self.root.as_os_str());
        if let Some(existing) = std::env::var_os("PYTHONPATH").filter(|p| !p.is_empty()) {
            path.push(if cfg!(windows) { ";" } else { ":" });
            path.push(existing);
        }
        cmd.env("PYTHONPATH", path)
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8");
        if let Some(home) = dirs::home_dir() {
            cmd.current_dir(home);
        }
        no_window(&mut cmd);
        Ok(cmd)
    }

    fn bridge(&self, args: &[String]) -> Result<Value, String> {
        let output = self
            .python_command()?
            .args(["-m", "diskcli.app_bridge"])
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("could not start Python for di: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let last = err.lines().last().unwrap_or("").trim();
            return Err(format!("di could not start: {last}"));
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("di bridge gave bad output: {e}"))
    }

    /// di's commands with their one-line help: `{"commands": [{name, help}]}`.
    pub fn commands(&self) -> Result<Value, String> {
        self.bridge(&["commands".to_string()])
    }

    /// Whether a command line may run, and whether it needs the user's OK.
    pub fn check(&self, args: &[String]) -> Result<DiCheck, String> {
        let mut argv = vec!["check".to_string()];
        argv.extend(args.iter().cloned());
        let out = self.bridge(&argv)?;
        if let Some(err) = out.get("error").and_then(Value::as_str) {
            return Err(err.to_string());
        }
        serde_json::from_value(out).map_err(|e| format!("di bridge gave bad output: {e}"))
    }

    /// Run `di args`, calling `on_event` with its output as it arrives and a
    /// final [`DiEvent::Exit`]. A command that changes the disk only runs with
    /// `confirm`. Stop it with [`DiRunner::stop`].
    pub fn run(
        &self,
        args: &[String],
        columns: u32,
        confirm: bool,
        request_id: &str,
        mut on_event: impl FnMut(DiEvent),
    ) -> Result<(), String> {
        let checked = self.check(args)?;
        if let (Some(reason), false) = (&checked.needs_confirm, confirm) {
            return Err(format!("{reason}; not run without confirmation"));
        }

        let mut cmd = self.python_command()?;
        cmd.args(["-m", "diskcli"])
            .args(&checked.argv)
            .env_remove("NO_COLOR")
            // Not a person at a keyboard: keeps di's pick-to-delete prompt off.
            .env_remove("DI_TTY")
            .env("DI_FORCE_COLOR", "1")
            .env("COLUMNS", columns.clamp(40, 400).to_string())
            .env("LINES", "50")
            .env("PYTHONUNBUFFERED", "1")
            .env("TERM", "xterm-256color")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let started = Instant::now();
        let mut child = {
            let mut live = self.live.lock().unwrap();
            if let Some(None) = live.runs.get(request_id) {
                live.runs.remove(request_id);
                return Err("Stopped".into());
            }
            if live.runs.len() >= MAX_LIVE_RUNS {
                return Err(format!(
                    "already running {MAX_LIVE_RUNS} di commands; stop one first"
                ));
            }
            let child = cmd
                .spawn()
                .map_err(|e| format!("could not start di: {e}"))?;
            live.runs.insert(request_id.to_string(), Some(child.id()));
            child
        };

        // One stream, as in a terminal: stderr is copied into the same
        // channel from a second thread, chunk by chunk.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let readers: Vec<_> = [
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .map(|mut stream| {
            let tx = tx.clone();
            std::thread::spawn(move || {
                // Raw chunks, not lines: di's spinner redraws a line with \r.
                let mut chunk = [0u8; 8192];
                while let Ok(n) = stream.read(&mut chunk) {
                    if n == 0 || tx.send(chunk[..n].to_vec()).is_err() {
                        break;
                    }
                }
            })
        })
        .collect();
        drop(tx);

        let mut pending = Vec::new();
        for chunk in rx {
            pending.extend_from_slice(&chunk);
            let text = take_utf8(&mut pending);
            if !text.is_empty() {
                on_event(DiEvent::Out { data: text });
            }
        }
        for reader in readers {
            let _ = reader.join();
        }
        if !pending.is_empty() {
            on_event(DiEvent::Out {
                data: String::from_utf8_lossy(&pending).into_owned(),
            });
        }

        let status = child.wait();
        self.live.lock().unwrap().runs.remove(request_id);
        let code = match status {
            Ok(s) => s.code().unwrap_or(-1),
            Err(_) => -1,
        };
        on_event(DiEvent::Exit {
            code,
            elapsed: started.elapsed().as_secs_f64(),
        });
        Ok(())
    }

    /// Stop a run (or, if it has not started yet, keep it from starting).
    pub fn stop(&self, request_id: &str) {
        let mut live = self.live.lock().unwrap();
        match live.runs.get(request_id) {
            Some(Some(pid)) => stop_process(*pid),
            Some(None) => {}
            None => {
                live.runs.insert(request_id.to_string(), None);
            }
        }
    }

    /// The folder this runner loads diskcli from.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runner() -> Option<DiRunner> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend");
        let runner = DiRunner::new(root);
        // These tests need a Python 3.10+, like di itself.
        runner.python_command().is_ok().then_some(runner)
    }

    #[test]
    fn utf8_split_across_chunks() {
        let mut buf = "héllo".as_bytes()[..2].to_vec(); // "h" + half of "é"
        assert_eq!(take_utf8(&mut buf), "h");
        assert_eq!(buf.len(), 1);
        buf.extend_from_slice(&"héllo".as_bytes()[2..]);
        assert_eq!(take_utf8(&mut buf), "éllo");
        let mut bad = vec![b'a', 0xFF, b'b'];
        assert_eq!(take_utf8(&mut bad), "a\u{FFFD}b");
    }

    #[test]
    fn exit_event_is_tagged_like_the_backend() {
        let json = serde_json::to_value(DiEvent::Exit {
            code: 0,
            elapsed: 1.5,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"type": "exit", "code": 0, "elapsed": 1.5})
        );
    }

    #[test]
    fn commands_and_checks_come_from_di() {
        let Some(di) = runner() else { return };
        let commands = di.commands().unwrap();
        let names: Vec<_> = commands["commands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"scan".to_string()));
        assert!(!names.contains(&"serve".to_string()));

        let clean = di
            .check(&["clean".into(), "~".into(), "--ye".into()])
            .unwrap();
        assert!(clean.needs_confirm.unwrap().contains("deletes files"));
        assert!(!clean.argv[1].starts_with('~'));
        assert!(di.check(&["scan".into()]).unwrap().needs_confirm.is_none());
        assert!(di
            .check(&["serve".into()])
            .unwrap_err()
            .contains("can't run inside the app"));
    }

    #[test]
    fn runs_stream_output_and_refuse_unconfirmed_changes() {
        let Some(di) = runner() else { return };
        let mut events = Vec::new();
        di.run(&["help".into()], 80, false, "r1", |e| events.push(e))
            .unwrap();
        let out: String = events
            .iter()
            .filter_map(|e| match e {
                DiEvent::Out { data } => Some(data.as_str()),
                _ => None,
            })
            .collect();
        assert!(out.contains("scan"), "help output: {out}");
        assert!(matches!(events.last(), Some(DiEvent::Exit { code: 0, .. })));

        let refused = di.run(
            &["ballast".into(), "set".into(), "1G".into()],
            80,
            false,
            "r2",
            |_| {},
        );
        assert!(refused
            .unwrap_err()
            .contains("not run without confirmation"));
    }

    #[test]
    fn a_stop_before_the_start_wins() {
        let Some(di) = runner() else { return };
        di.stop("early");
        assert_eq!(
            di.run(&["help".into()], 80, false, "early", |_| {})
                .unwrap_err(),
            "Stopped"
        );
        assert!(di.live.lock().unwrap().runs.is_empty());
    }
}
