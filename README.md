# Disk Intelligence

Find what is eating your disk, see what changed since last time, and keep the
space you free from filling straight back up.

Two front ends share one Python core and one database:

- **`di`**: a fast, dependency-free command line tool for scanning, growth
  tracking, cleanup and a free-space guard.
- **Desktop app**: Electron + React UI over a local FastAPI backend, with scan
  findings, snapshots, folder comparison and space-keeping tips.

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

Everything works on macOS and Windows; the platform-specific parts are chosen automatically.

| | macOS | Windows | Linux |
|---|---|---|---|
| CLI launcher | `di` (bash) | `di.cmd` | `di` (bash) |
| `di caches` locations | `~/Library/Caches`, `~/Library/Application Support`, `~/.*` | `%LOCALAPPDATA%`, `%APPDATA%`, `~\.*` | `~/.cache`, `~/.config`, `~/.*` |
| Extra caches | Homebrew, Xcode, Simulator, CocoaPods, app updaters | NuGet, Scoop, `%LOCALAPPDATA%\Temp`, CrashDumps, app updaters | – |
| `di guard --install` | launchd agent | Task Scheduler task (`DiskIntelligenceGuard`, runs hidden via `pythonw`) | prints a crontab line |
| Guard notifications | Notification Center | Windows toast | `notify-send` |
| `di tips` | APFS snapshots, purgeable space, swap, Xcode, Messages … | WSL/Docker `.vhdx`, hiberfil, page file, restore points, WinSxS, Storage Sense … | shared tips |
| Desktop app | Electron DMG (`npm run dist:mac`) | Electron NSIS installer (`npm run dist:win`, `scripts\package.bat`) | not packaged |

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
| `di scan [path] -d 2` | Rank folders by size, with a bar, share, recent bytes and last-touched time |
| `di recent [path] --days 7` | What was written recently, by folder and by file (no baseline needed) |
| `di snapshot [path]` | Record a baseline |
| `di growth [path]` | Diff against the latest baseline: what grew, what shrank, rate per day |
| `di snapshots` / `di forget <id>` | List / delete baselines |
| `di reclaim [path]` | Rank regenerable and cache folders; in a terminal, type a row number to delete it (asks y/N) |

### Getting space back and keeping it

macOS treats freed space as room for caches, APFS snapshots and swap, so a
cleanup rarely sticks. These commands give space back and keep a floor under it.
**Anything that deletes is a dry run unless you pass `--yes`** — or, in a terminal, you type a row's number at the
`delete #` prompt that `di .`, `di reclaim`, `di clean` and `di caches` leave open (one row at a time; name-matched
folders and slow-to-rebuild caches ask y/N first).

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
- **Du-hast-much**: quick per-folder sizing with live progress and history.
- **Folder comparison**: source vs target (mirror or backup validation) with
  optional hash verification. Design: `docs/plans/2026-01-15-folder-comparison-design.md`.
- **Snapshots**: save scans and comparisons, reopen and refresh them later.
- **Keeping space free**: tips relevant to this Mac (Docker, snapshots, swap,
  Xcode, Homebrew ...) with copyable commands, served from the same list as `di tips`.
- **Themes**: Light, Dark, Sepia, Dark Sepia.

The app only analyses; cleanup lives in `di`.

## Architecture

```
Electron main (frontend/electron/)
  ├── backend.cjs     supervises the Python backend: finds a free port, health-checks, restarts
  └── React UI (frontend/src/)  ── HTTP/SSE on 127.0.0.1 ──►  FastAPI (backend/main.py)
                                                                ├── security/   path validation, sanitising, headers, redacting logger
                                                                ├── database.py SQLAlchemy / SQLite snapshots
                                                                └── diskcli/tips.py  shared tips
di / di.cmd ──► backend/diskcli/  stdlib only: walker, store (SQLite baselines), commands, maint, tips
```

| Path | Contents |
|---|---|
| `backend/main.py` | FastAPI app: scan (+SSE stream), findings, extensions, snapshots, compare, du-hast-much, tips |
| `backend/diskcli/` | The `di` CLI. `walker.py` is the fast single-pass scanner; `maint.py` holds clean/caches/guard/ballast |
| `backend/security/` | Path validator, input sanitiser, secure logger, security headers, encryption helper |
| `frontend/src/` | React 19 + TypeScript + Vite. `api.ts` is the HTTP client |
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
