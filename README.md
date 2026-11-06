# Disk Intelligence

Find what is eating your disk, see what changed since last time, and keep the
space you free from filling straight back up.

Two front ends:

- **`di`**: a fast, dependency-free Python command line tool for scanning,
  growth tracking, cleanup and a free-space guard.
- **Desktop app**: a Tauri app (React UI + Rust core in one small binary) with
  scan findings, snapshots, folder comparison, space-keeping tips, and `di`
  itself in a terminal window.

Everything runs locally. Nothing leaves the machine (see [Security](#security)).

> The previous Electron + Python (FastAPI) desktop app still builds
> (`npm run dev:electron`, `npm run dist:electron`) while the Tauri app beds in.
> It will be removed once the Tauri app has been used for a while.

## Quick start

```bash
# CLI: needs only Python 3.10+, no packages
ln -s "$PWD/di" ~/.local/bin/di      # macOS / Linux: anywhere on your PATH
di help
```

```bat
:: Windows: di.cmd finds Python via the py launcher (or python, or %DI_PYTHON%)
setx PATH "%PATH%;C:\path\to\disk-maintenance"
di help
```

```bash
# Desktop app (development): needs Node.js 18+ and Rust (https://rustup.rs)
npm run install-all
npm run dev                            # Vite on :5176 + the Tauri window; first run compiles the Rust core
npm test                               # Rust core tests
```

On macOS, give your terminal (and the packaged app) **Full Disk Access** in
System Settings → Privacy & Security, or scans will skip protected folders.
On Linux, Tauri needs the WebKitGTK dev packages (see [BUILD.md](BUILD.md#prerequisites)).

## Platform support

Everything works on macOS, Windows and Linux (x64 or ARM, including a Raspberry Pi); the platform-specific parts are chosen automatically.

| | macOS | Windows | Linux |
|---|---|---|---|
| CLI launcher | `di` (bash) | `di.cmd` | `di` (bash) |
| `di caches` locations | `~/Library/Caches`, `~/Library/Application Support`, `~/.*` | `%LOCALAPPDATA%`, `%APPDATA%`, `~\.*` | `~/.cache`, `~/.config`, `~/.*` |
| Extra caches | Homebrew, Xcode, Simulator, CocoaPods, app updaters | NuGet, Scoop, `%LOCALAPPDATA%\Temp`, CrashDumps, app updaters | – |
| Browser / chat caches (not auto) | Chrome, Edge, Brave, Vivaldi, Firefox, Discord, Slack, Spotify | same + new Teams | same |
| `di move` finds | Steam, Docker disk, VirtualBox/VMware, Android, Ollama/LM Studio/Hugging Face, iPhone backups | same + WSL distros, Hyper-V, Epic, Xbox games, Downloads/Videos/… (Location tab) | Steam, VMs, Android, models |
| `di guard --install` | launchd agent | Task Scheduler task (`DiskIntelligenceGuard`, runs hidden via `pythonw`) | crontab entry |
| Guard notifications | Notification Center | Windows toast | `notify-send` |
| `di tips` | APFS snapshots, purgeable space, swap, Xcode, Messages … | sizes of hiberfil, page file, Windows.old, Recycle Bin, update downloads, crash dumps; WSL/Docker `.vhdx`, restore points, WinSxS … | apt cache, journald, Docker, Trash + shared tips |
| Desktop app | .app + DMG (`scripts/package.sh`) | MSI + setup.exe (`scripts\package.bat`); uses WebView2 (built into Windows 11, installed by the setup on 10) | .deb, .rpm and AppImage for the build machine's arch (`scripts/package-linux.sh`) |

### Raspberry Pi (Raspberry Pi OS, arm64)

The CLI is plain Python, so it runs as-is on a Pi 5 (Pi OS ships Python 3.11+):

```bash
ln -s "$PWD/di" ~/.local/bin/di
di                                   # works over SSH on Pi OS Lite too
di guard --auto --install            # adds a crontab entry; notify-send only shows on the desktop edition
```

For the desktop app, build on the Pi itself: install Node.js, Rust and the WebKitGTK packages, then
`./scripts/package-linux.sh` (see [BUILD.md](BUILD.md#raspberry-pi--linux-arm64)).

Shared everywhere: `di clean` (including .NET `bin/`/`obj/` next to a `.csproj`), ballast,
scan/recent/growth/reclaim, and the app's tips panel (it only shows tips for the OS it runs on).

## The `di` command line

`di` (or `di help`) opens with a quick summary: main disk, other connected drives, memory and swap with the
biggest memory users, and recent changes (free-space trend, latest baseline diff, big files changed this week).
It reads OS counters and the Spotlight index, never walks the disk, so it takes under a second. `di summary --json`
gives the same data for scripts. `di help` then lists commands; `di help <command>` shows every option.

### Finding what uses space

| Command | What it does |
|---|---|
| `di summary` | Disk, drives, memory and recent changes at a glance (what bare `di` shows) |
| `di .` / `di <path>` | Insights for one folder: biggest folders, new files, dev junk and caches (type a row number to delete it), duplicate files and folders, old folders, file types |
| `di scan [path] -d 2` | Rank folders by size, with a bar, share, recent bytes and last-touched time; rows are numbered for the delete prompt |
| `di recent [path] --days 7` | What was written recently, by folder and by file (no baseline needed) |
| `di snapshot [path]` | Record a baseline |
| `di growth [path]` | Diff against the latest baseline: what grew, what shrank, rate per day |
| `di snapshots` / `di forget <id>` | List / delete baselines |
| `di reclaim [path]` | Rank regenerable and cache folders; in a terminal, type a row number to delete it |
| `di move` | What could live on another drive, and the safe way to move each (see below) |

### Getting space back and keeping it

macOS treats freed space as room for caches, APFS snapshots and swap, so a
cleanup rarely sticks. These commands give space back and keep a floor under it.
**Anything that deletes is a dry run unless you pass `--yes`** — or, in a terminal, you type a row's number at the
`delete #` prompt that `di .`, `di scan`, `di recent`, `di growth`, `di reclaim`, `di clean` and `di caches` leave open
(one row at a time, each confirmed y/n; Enter lists what is left, q quits). Numbered rows show the whole path.

Cloud sync folders (OneDrive, Dropbox, iCloud …) are handled specially: files that are only in the cloud count as
0 bytes, downloaded ones are marked ☁ and totalled with how to free them through the provider, and `reclaim`
never offers to delete inside them (that would delete from the cloud too).

```bash
di clean                           # node_modules, __pycache__, .next, .vite ... in ~/dev (or ~/source/repos,
                                   # ~/projects, ~/code ... whichever exists), grouped by project
di clean ~/dev --older-than 14 -y  # only projects idle for 2+ weeks
di clean ~/dev --all               # also .venv, target/, build/, dist/ (only when a manifest proves they're build output)
di caches -v                       # npm/yarn/bun/pip/uv/cargo/go/Homebrew/Xcode/editor/updater/browser caches
di caches --yes                    # clean the auto-safe ones (uses `npm cache clean` etc. when installed);
                                   # browser and chat caches are listed too, pick them by number once the app is closed
di ballast set 5G                  # reserve 5 GB; `di ballast release` hands it back in an emergency
di guard --auto --dev ~/dev --install   # launchd agent every 2h: notify < 20G, auto-clean < 20G,
                                        # release ballast < 8G
di guard --history                 # free-space readings the guard has logged
di guard --uninstall
di tips                            # where "System Data" comes from and how to take it back; on Windows
                                   # with live sizes: hiberfil.sys, pagefile.sys, Windows.old, Recycle Bin ...
```

### Moving things to another drive

Deleting caches only goes so far. `di move` lists what is big on the drive holding your home folder and
could live on another one: Steam / Epic / Xbox games (one row per game), WSL distros, the Docker Desktop disk,
Hyper-V / VirtualBox / VMware machines, Android emulator images and SDK, Ollama / LM Studio / Hugging Face
models, NuGet packages, iPhone backups, Windows' Downloads / Videos / Pictures / Music / Documents / Desktop,
folders under your home untouched for 6 months, and big files.

Each row says how to move it **without breaking the app that owns it**: Steam's storage manager,
`wsl --manage <distro> --move`, Docker's disk image location, the folder's Location tab, an environment variable
plus a move for model and emulator folders, a junction for iPhone backups. Plain data gets a `robocopy` (Windows) or
`mv` command. `di move` never moves anything itself.

```bash
di move                    # suggests the other local drive with the most room
di move --to E:\           # or a drive / folder of your choice
di move --quick            # app data and known folders only, without searching your files
di move --days 365 -m 2G   # stricter: untouched for a year, 2 GB and up
```

After table commands, `di` occasionally prints one relevant tip (every 6 hours,
or every time when the disk is low). Set `DI_TIPS=0` to turn that off.

`scripts/clear_node_modules_pycache.sh` is the original report-only script that
`di clean` replaces.

## Desktop app

The app has no main window: it is a cluster of small skinned windows, Winamp
style, floating straight on your desktop with nothing behind them. They dock
edge to edge around a centre point and never come apart. Clicks on the
desktop between them go through to whatever is underneath.

Each tool is one window; its parts are sections inside it that open and close.
A first launch opens just the hub, scan and du-hast-much.

- **Moving everything**: drag the main window (DISK INTELLIGENCE) by its title
  bar and every window moves with it; CENTRE puts them back in the middle. The
  position is remembered.
- **Moving one window**: drag its title bar onto another window to swap the two
  (a drop anywhere else snaps back). ARRANGE re-packs everything.
- **Resizing**: drag any edge or the corner grip; neighbours act as walls and
  the rest re-dock around it. Double-click a title bar to shade a window down to
  one line. The arrangement is remembered between launches.

The windows:

| Window | What it does |
|---|---|
| Disk Intelligence (hub) | Free space on every disk (the home disk first, removable drives marked ⏏, red when under 10% free), and the controls: SCAN, COMPARE, DHM, DI, TIPS, SKINS, ARRANGE, CENTRE. SKINS opens the skin picker inside the hub, which grows to fit. Minimise and quit live here (there is no OS frame). |
| Scan | Folder bar, progress, then the result's sections: **Findings** (large and old folders, caches, duplicates, cold archives), **File types**, and the **Library** of saved scans and comparisons. One section is open at a time. SAVE keeps a scan; opening a saved one shows it here and quietly refreshes it. |
| Compare | **Folders** (source, target, optional hash check; folded away once there are results), status filters, TREE/PATHS, SAVE, and the source and target trees side by side like a diff: same rows, one scroll position. PATHS lists each side's differing files as copyable paths. Design: `docs/plans/2026-01-15-folder-comparison-design.md`. |
| du-hast-much | Folder, depth, top N, latest-first, recent scans (a dropdown), and the CLI-style table with live progress. Sized to show the controls and a top-10 table without scrolling. |
| di | The real `di` command line: quick commands, the prompt, and a **Commands** section listing every command, each with its help folded away until you open it. Anything that deletes or schedules something (`clean --yes`, `caches --yes`, `guard --install/--auto`, `ballast set/release`, `forget`) asks first; the pick-to-delete prompt stays terminal-only. `di` is Python, so this window needs Python 3.10+ on the machine (or `DI_PYTHON`). |
| Tips | Every way to keep freed space free (the list `di tips` prints), the ones for this machine first; each opens to its text and a command to copy. |
| Backend | Legacy Electron app only: appears by itself if the Python backend can't start (why, retry, the log). |

Skins: Cold Steel, Silver, Butter, Sun Metal (hot orange metal fading to yellow),
Frost, Gunmetal, Obsidian. Any of them can have a DARK display or WHITE paper
inside; each skin remembers which.

Apart from the di window, the app only analyses; cleanup lives in `di`.

How the floating works: the app opens one transparent, undecorated window over
the screen's work area (`frontend/src-tauri/src/overlay.rs`). On macOS and
Windows it lets clicks through while the pointer is off our windows, and
watches the pointer to take them back when it returns; on Linux the window's
input shape is set to our windows, so only they take clicks. Transparency on
macOS uses Tauri's `macOSPrivateApi` (fine outside the App Store). In a plain
browser tab (`npm run dev:vite`) the windows sit on the page instead. The
legacy Electron app does the same with `setIgnoreMouseEvents` / `setShape`.

## Architecture

```
Tauri app (frontend/src-tauri/)  one transparent window over the screen's work area
  └── React UI (frontend/src/) ── invoke() / Channel (in-process IPC) ──► commands (src-tauri/src/lib.rs)
                                                                          ├── overlay.rs  fit to the screen, click-through
                                                                          └── disk-core (core/)
                                                                                ├── scanner    parallel walk, per-folder totals
                                                                                ├── analyzer   findings
                                                                                ├── compare    folder comparison
                                                                                ├── duhast     per-folder sizing
                                                                                ├── snapshots  SQLite
                                                                                ├── tips       same list as di tips
                                                                                └── di         runs `python -m diskcli` for the di window
di / di.cmd ──► backend/diskcli/  stdlib only: walker, store (SQLite baselines), commands, maint, tips
```

There is no server, port or HTTP: the UI calls Rust functions directly, and long
scans stream progress over a Tauri `Channel` and can be cancelled.

| Path | Contents |
|---|---|
| `core/` | `disk-core`, the Rust library with everything the app does. `cargo test` runs without a GUI |
| `frontend/src-tauri/` | The Tauri shell: commands, the floating window, bundle config, icons (`icons/icon.svg` is the source) |
| `frontend/src/` | React 19 + TypeScript + Vite. `api.ts` calls Tauri commands (HTTP under Electron); `desktop.ts` wraps the shell (folder picker, dialogs, click-through) |
| `frontend/src/wm/` | The window manager: `layout.ts` packs the docked cluster, `state.ts` is its reducer, `Cluster`/`Window` draw it, `clickThrough.ts` lets clicks reach the desktop |
| `frontend/src/windows/` | The windows, grouped by tool (hub, scan, compare, dhm, di, tips, library) |
| `frontend/src/state/` | Shared state for each tool, so its separate windows show the same scan, comparison or terminal |
| `backend/diskcli/` | The `di` CLI. `walker.py` is the fast single-pass scanner; `maint.py` holds clean/caches/guard/ballast; `app_bridge.py` tells the app which commands exist and which change the disk |
| `backend/main.py`, `backend/di_runner.py`, `backend/security/`, `frontend/electron/` | Legacy Electron + FastAPI app |
| `scripts/` | Build, package, verify and audit scripts |

## Data locations

| What | Where (macOS) |
|---|---|
| App snapshots | `~/Library/Application Support/DiskIntelligence/disk_intelligence.db` (same file and schema as the Electron app, so existing snapshots carry over) |
| CLI baselines, guard log, ballast, tip state | `~/Library/Application Support/DiskIntelligence/` (override the DB with `DISK_INTELLIGENCE_DB`) |
| Guard launchd agent | `~/Library/LaunchAgents/com.diskintelligence.guard.plist` |

Windows uses `%APPDATA%\DiskIntelligence` (the guard's Task Scheduler launcher is
`guard_task.pyw` there), Linux `~/.local/share/DiskIntelligence`.

## Building

See [BUILD.md](BUILD.md). In short: `scripts/package.sh` (macOS),
`scripts\package.bat` (Windows) or `scripts/package-linux.sh` run `tauri build`,
which leaves installers in `frontend/src-tauri/target/release/bundle/`.
Build each OS's installer on that OS.

Size: the Tauri app is a single binary of a few MB plus diskcli's Python
sources; the system webview (WebView2, WKWebView, WebKitGTK) does the drawing.
The legacy Electron build was about 270 MB unpacked: ~230 MB of Chromium and a
30 MB PyInstaller backend.

Legacy Electron packaging refuses a `backend/dist` binary that is older than the
backend source: run `scripts/build-backend.sh` first, or set `DI_ALLOW_STALE_BACKEND=1`.

## Security

The app is local-only: there is no network listener at all (the UI talks to the
Rust core over Tauri's in-process IPC), the CSP only allows the app's own
content and that IPC channel, every path from the UI is validated
(`core/src/paths.rs`), the app only reads (cleanup lives in `di`), and
dependencies are audited with telemetry disabled. The legacy Electron app keeps
its 127.0.0.1-only backend, CORS and input sanitising.

Background documents (written during the March 2026 hardening pass; see
`todo.md` for what's still open):

| Document | Contents |
|---|---|
| `SECURITY_AUDIT_PLAN.md` | The 7-phase hardening plan |
| `THREAT_MODEL.md` | Assets, STRIDE analysis, attack scenarios, risk matrix |
| `SECURITY_REQUIREMENTS.md` | Numbered requirements (SR-xxx) |
| `VULNERABILITY_REPORT.md` | Initial findings (CRITICAL/HIGH/MEDIUM/LOW) |
| `PHASE1_COMPLETE.md` … `PHASE5_COMPLETE.md` | What each phase delivered |
| `TELEMETRY_*`, `NODE_TELEMETRY_*` | Python / Node dependency telemetry audits |

## Troubleshooting

- **Scans miss folders / show "unreadable"**: grant Full Disk Access.
- **"Disk Intelligence is damaged" / won't open (macOS)**: builds without a
  Developer ID are ad-hoc signed. Run `xattr -dr com.apple.quarantine "/Applications/Disk Intelligence.app"`.
- **Blank window on Windows 10**: WebView2 is missing; the installer downloads it,
  or get it from Microsoft's WebView2 page.
- **The di window says it needs Python**: `di` is Python. Install Python 3.10+
  (python.org), or point `DI_PYTHON` at one, and restart the app.
- **A black screen behind the windows (Linux)**: the floating windows need a
  compositing window manager (any modern desktop has one).
- **`di guard` notifications don't appear**: on macOS, allow notifications for
  "Script Editor" (osascript) in System Settings → Notifications. On Windows,
  toasts are sent as Windows PowerShell; check Settings → System → Notifications
  and Focus Assist.
- **No colours / odd characters in the Windows console**: `di` turns on ANSI
  handling itself; use Windows Terminal if an old console still shows escape codes.
