# Disk Intelligence

Find what is eating your disk, see what changed since last time, and keep the
space you free from filling straight back up.

Two front ends share one Python core and one database:

- **`di`**: a fast, dependency-free command line tool for scanning, growth
  tracking, cleanup and a free-space guard.
- **Desktop app**: Electron + React UI over a local FastAPI backend, with scan
  findings, snapshots, folder comparison, space-keeping tips, and `di` itself
  in a terminal window.

Everything runs locally. Nothing leaves the machine (see [Security](#security)).

> The `worktree-tauri-migration` branch holds an in-progress Tauri + Rust port.
> `main` is Electron + Python; this README describes `main`.

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

# Desktop app (development)
pip install -r backend/requirements.txt
npm run install-all
npm run dev                            # Python backend on :8001 + Vite on :5176 + Electron window
```

On macOS, give your terminal (and the packaged app) **Full Disk Access** in
System Settings → Privacy & Security, or scans will skip protected folders.
On Windows, use `npm run dev:win` (runs `python` instead of `python3`).

## Platform support

Everything works on macOS, Windows and Linux (x64 or ARM, including a Raspberry Pi); the platform-specific parts are chosen automatically.

| | macOS | Windows | Linux |
|---|---|---|---|
| CLI launcher | `di` (bash) | `di.cmd` | `di` (bash) |
| `di caches` locations | `~/Library/Caches`, `~/Library/Application Support`, `~/.*` | `%LOCALAPPDATA%`, `%APPDATA%`, `~\.*` | `~/.cache`, `~/.config`, `~/.*` |
| Extra caches | Homebrew, Xcode, Simulator, CocoaPods, app updaters | NuGet, Scoop, `%LOCALAPPDATA%\Temp`, CrashDumps, app updaters | – |
| `di guard --install` | launchd agent | Task Scheduler task (`DiskIntelligenceGuard`, runs hidden via `pythonw`) | crontab entry |
| Guard notifications | Notification Center | Windows toast | `notify-send` |
| `di tips` | APFS snapshots, purgeable space, swap, Xcode, Messages … | WSL/Docker `.vhdx`, hiberfil, page file, restore points, WinSxS, Storage Sense … | apt cache, journald, Docker, Trash + shared tips |
| Desktop app | Electron DMG (`npm run dist:mac`) | Electron NSIS installer (`npm run dist:win`, `scripts\package.bat`) | AppImage / .deb for the build machine's arch (`scripts/package-linux.sh`) |

### Raspberry Pi (Raspberry Pi OS, arm64)

The CLI is plain Python, so it runs as-is on a Pi 5 (Pi OS ships Python 3.11+):

```bash
ln -s "$PWD/di" ~/.local/bin/di
di                                   # works over SSH on Pi OS Lite too
di guard --auto --install            # adds a crontab entry; notify-send only shows on the desktop edition
```

For the desktop app, build on the Pi itself: `sudo apt install python3-venv nodejs npm`, then
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
di clean ~/dev                     # node_modules, __pycache__, .next, .vite ... grouped by project
di clean ~/dev --older-than 14 -y  # only projects idle for 2+ weeks
di clean ~/dev --all               # also .venv, target/, build/, dist/ (only when a manifest proves they're build output)
di caches -v                       # npm/yarn/bun/pip/uv/cargo/go/Homebrew/Xcode/editor/updater caches
di caches --yes                    # clean the auto-safe ones (uses `npm cache clean` etc. when installed)
di ballast set 5G                  # reserve 5 GB; `di ballast release` hands it back in an emergency
di guard --auto --dev ~/dev --install   # launchd agent every 2h: notify < 20G, auto-clean < 20G,
                                        # release ballast < 8G
di guard --history                 # free-space readings the guard has logged
di guard --uninstall
di tips                            # where "System Data" comes from and how to take it back
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

- **Moving**: drag a title bar onto another window to swap the two (a drop
  anywhere else snaps back). ARRANGE re-packs everything.
- **Resizing**: drag any edge or the corner grip; neighbours act as walls and
  the rest re-dock around it. Double-click a title bar to shade a window down to
  one line. New windows open at whatever size fits the free space.
- **Closing**: a tool's windows belong together and close together (closing a
  scan's control window closes its findings and types too). The arrangement is
  remembered between launches.

The windows:

| Window | What it does |
|---|---|
| Disk Intelligence | Status, free space, a scrolling marquee. Minimise and quit live here (there is no OS frame). |
| Controls | Opens everything else: SCAN, COMPARE, DHM, DI, LIB, TIPS, SKINS, ARRANGE. |
| Scan (one per scan) | Folder, progress, totals, SAVE. Opens **Findings** (large and old folders, caches, duplicates, cold archives) and **Types** (sizes by extension) beside it. |
| Compare (one per comparison) | Source and target folders, optional hash check, status filters, TREE/PATHS, SAVE. Opens a hinged **Source / Target** pair that reads like a diff: same rows, one scroll position. PATHS lists each side's differing files as copyable paths. Design: `docs/plans/2026-01-15-folder-comparison-design.md`. |
| Library | Saved scans and comparisons; opening one gives it windows of its own and quietly refreshes it. |
| du-hast-much + DHM output | Settings and recent scans; the CLI-style table with live progress. |
| di + di commands | The real `di` command line, and its suggestions: quick commands and every command with its help. Anything that deletes or schedules something (`clean --yes`, `caches --yes`, `guard --install/--auto`, `ballast set/release`, `forget`) asks first; the pick-to-delete prompt stays terminal-only. |
| Tips (one per tip) | Each way to keep freed space free, with its command to copy (the list `di tips` prints). TIPS opens the ones that apply to this machine. |
| Skins | Cold Steel, Silver & White, Warm Yellow, Frost, Gunmetal, Obsidian. |
| Backend | Appears by itself if the backend can't start: why, retry, and the log. |

Apart from the di window, the app only analyses; cleanup lives in `di`.

How the floating works: Electron opens one transparent, frameless window over
the screen's work area. On macOS and Windows it ignores the mouse except over a
window of ours (`setIgnoreMouseEvents` with forwarding); on Linux the window is
shaped to the windows (`setShape`), so no compositor is needed. In a plain
browser tab (`npm run dev:vite`) the windows sit on the page instead.

## Architecture

```
Electron main (frontend/electron/)
  ├── backend.cjs     supervises the Python backend: finds a free port, health-checks, restarts
  └── React UI (frontend/src/)  ── HTTP/SSE on 127.0.0.1 ──►  FastAPI (backend/main.py)
                                                                ├── security/   path validation, sanitising, headers, redacting logger
                                                                ├── database.py SQLAlchemy / SQLite snapshots
                                                                ├── diskcli/tips.py  shared tips
                                                                └── di_runner.py  runs `backend --di …` for the di window
di / di.cmd ──► backend/diskcli/  stdlib only: walker, store (SQLite baselines), commands, maint, tips
```

| Path | Contents |
|---|---|
| `backend/main.py` | FastAPI app: scan (+SSE stream), findings, extensions, snapshots, compare, du-hast-much, tips, di runs. `main.py --di <args>` runs di |
| `backend/di_runner.py` | Starts di processes for the di window, streams their output, gates destructive commands |
| `backend/diskcli/` | The `di` CLI. `walker.py` is the fast single-pass scanner; `maint.py` holds clean/caches/guard/ballast |
| `backend/security/` | Path validator, input sanitiser, secure logger, security headers, encryption helper |
| `frontend/src/` | React 19 + TypeScript + Vite. `api.ts` is the HTTP client |
| `frontend/src/wm/` | The window manager: `layout.ts` packs the docked cluster, `state.ts` is its reducer, `Cluster`/`Window` draw it, `clickThrough.ts` lets clicks reach the desktop |
| `frontend/src/windows/` | The windows, grouped by tool (hub, scan, compare, dhm, di, tips, library) |
| `frontend/src/state/` | Shared state for each tool, so its separate windows show the same scan, comparison or terminal |
| `frontend/electron/` | Main process, preload bridge, backend supervisor |
| `scripts/` | Build, package, verify and audit scripts |

## Data locations

| What | Where (macOS) |
|---|---|
| App snapshots (packaged) | `~/Library/Application Support/DiskIntelligence/disk_intelligence.db` |
| App snapshots (dev) | `backend/disk_intelligence.db` |
| CLI baselines, guard log, ballast, tip state | `~/Library/Application Support/DiskIntelligence/` (override the DB with `DISK_INTELLIGENCE_DB`) |
| Guard launchd agent | `~/Library/LaunchAgents/com.diskintelligence.guard.plist` |

Windows uses `%APPDATA%\DiskIntelligence` (the guard's Task Scheduler launcher is
`guard_task.pyw` there), Linux `~/.local/share/DiskIntelligence`.

## Building

See [BUILD.md](BUILD.md). In short: `npm run package:mac` / `scripts/package.sh`
(macOS) or `scripts\package.bat` (Windows) builds the backend with PyInstaller,
builds the frontend, and packages with electron-builder into `release/`.
PyInstaller can't cross-compile, so build each OS's installer on that OS.
`npm run verify` checks the packaged app.

## Security

The app is designed to be local-only: backend bound to 127.0.0.1, CORS
restricted to localhost origins, path validation and input sanitisation on
every path-taking endpoint, security headers, CSP, redacted logging, Electron
context isolation, and audited dependencies with telemetry disabled.

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
- **App says "Backend unavailable"**: the banner has Retry and a log link. In
  dev, check `npm run dev:backend` output. The backend moves to the next free
  port if 8001 is taken.
- **Packaged backend killed on first launch (macOS)**: the supervisor clears the
  quarantine flag; if it persists, run `xattr -dr com.apple.quarantine "/Applications/Disk Intelligence.app"`.
- **`di guard` notifications don't appear**: on macOS, allow notifications for
  "Script Editor" (osascript) in System Settings → Notifications. On Windows,
  toasts are sent as Windows PowerShell; check Settings → System → Notifications
  and Focus Assist.
- **No colours / odd characters in the Windows console**: `di` turns on ANSI
  handling itself; use Windows Terminal if an old console still shows escape codes.
