# Disk Intelligence

Find what is eating your disk, see what changed since last time, and keep the
space you free from filling straight back up.

Two front ends:

- **`di`**: a fast, dependency-free Python command line tool for scanning,
  growth tracking, cleanup and a free-space guard.
- **Desktop app**: a Tauri app (React UI + Rust core in one small binary) with
  scan findings, snapshots, folder comparison and space-keeping tips.

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
| `di guard --install` | launchd agent | Task Scheduler task (`DiskIntelligenceGuard`, runs hidden via `pythonw`) | crontab entry |
| Guard notifications | Notification Center | Windows toast | `notify-send` |
| `di tips` | APFS snapshots, purgeable space, swap, Xcode, Messages … | WSL/Docker `.vhdx`, hiberfil, page file, restore points, WinSxS, Storage Sense … | apt cache, journald, Docker, Trash + shared tips |
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

- **Scan & findings**: large folders, old large folders, cache/regenerable
  folders, duplicate-name folders and files, cold archives, and a breakdown by
  file extension.
- **Du-hast-much**: quick per-folder sizing, each folder shown as soon as it is measured.
- **Folder comparison**: source vs target (mirror or backup validation) with
  optional hash verification. Design: `docs/plans/2026-01-15-folder-comparison-design.md`.
- **Snapshots**: save scans and comparisons, reopen and refresh them later.
- **Keeping space free**: tips relevant to this Mac (Docker, snapshots, swap,
  Xcode, Homebrew ...) with copyable commands, served from the same list as `di tips`.
- **Themes**: Light, Dark, Sepia, Dark Sepia.

The app only analyses; cleanup lives in `di`.

## Architecture

```
Tauri app (frontend/src-tauri/)
  └── React UI (frontend/src/) ── invoke() / Channel (in-process IPC) ──► commands (src-tauri/src/lib.rs)
                                                                          └── disk-core (core/)
                                                                                ├── scanner    parallel walk, per-folder totals
                                                                                ├── analyzer   findings
                                                                                ├── compare    folder comparison
                                                                                ├── duhast     per-folder sizing
                                                                                ├── snapshots  SQLite
                                                                                └── tips       same list as di tips
di / di.cmd ──► backend/diskcli/  stdlib only: walker, store (SQLite baselines), commands, maint, tips
```

There is no server, port or HTTP: the UI calls Rust functions directly, and long
scans stream progress over a Tauri `Channel` and can be cancelled.

| Path | Contents |
|---|---|
| `core/` | `disk-core`, the Rust library with everything the app does. `cargo test` runs without a GUI |
| `frontend/src-tauri/` | The Tauri shell: commands, window and bundle config, icons (`icons/icon.svg` is the source) |
| `frontend/src/` | React 19 + TypeScript + Vite. `api.ts` calls Tauri commands (HTTP under Electron); `desktop.ts` wraps the shell (folder picker, dialogs) |
| `backend/diskcli/` | The `di` CLI. `walker.py` is the fast single-pass scanner; `maint.py` holds clean/caches/guard/ballast |
| `backend/main.py`, `backend/security/`, `frontend/electron/` | Legacy Electron + FastAPI app |
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
- **`di guard` notifications don't appear**: on macOS, allow notifications for
  "Script Editor" (osascript) in System Settings → Notifications. On Windows,
  toasts are sent as Windows PowerShell; check Settings → System → Notifications
  and Focus Assist.
- **No colours / odd characters in the Windows console**: `di` turns on ANSI
  handling itself; use Windows Terminal if an old console still shows escape codes.
