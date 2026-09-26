# TODO

Collected 2026-09-26 from a read of the code and every `.md` in the repo.
Most important first within each section.

## Priority 1: scanner fixes (app backend)

The app's scanner is wrong and heavy in ways that matter for a disk tool. These come first.
Measured on `~/dev` (522k files, M1, 8 GB): `du` 12.2s · `di` walker 19.7s / 25 MB ·
app scanner 20.9s / ~450 MB. Disk metadata I/O is the speed floor, not Python.

- [x] **1. The app can't see `~/Library`.** `DiskScanner.should_ignore` (`backend/main.py`)
      does a lowercase *substring* match against `IGNORE_PATHS`, so `/Library` hides
      `~/Library` and `/private` hides `~/dev/private-notes` (both confirmed). `~/Library` is
      where "System Data" lives. Match exact absolute prefixes / exact folder names instead.
      *Small fix; do it now even if the Tauri port goes ahead.*
- [x] **2. Sizes are too high.** It `os.stat`s (follows symlinks) and counts hard-linked files
      more than once: 20.2 GB for `~/dev` vs 17.2 GB (`di`) and 18.6 GB (`du`). Use `lstat`,
      dedupe `(dev, inode)`, and use `st_blocks` for real on-disk size.
- [x] **3. Memory use.** It keeps a dict with 3 ISO date strings per file: ~450 MB for 500k
      files, GBs for a home-folder scan on an 8 GB Mac, which pushes it into swap (itself
      "System Data"). Keep per-folder totals + top-N largest files instead, like
      `diskcli/walker.py` (25 MB). That covers every current finding.
- [ ] **4. The backend freezes during a scan.** `scan_async` walks on the event-loop thread, so
      health checks and every other request stall until it finishes. Run the walk in a
      thread (`asyncio.to_thread`) and feed progress through a queue.
- [ ] **5. Old scans are never freed.** The in-memory `scans` dict keeps every scan until the
      backend restarts. Keep the last 2–3 (LRU), or drop a scan once it's saved as a snapshot.
- [ ] **6. One scanner, not four.** `DiskScanner`, `du_hast_much._walk_size`,
      `FolderComparator` and `diskcli.walker` each walk the disk their own way. Consolidate
      on the walker. While there: `_analyze_cache_candidates` counts nested matches twice
      (every folder under a match, and everything under a `/tmp`-looking path). Keep only the
      outermost match, as `di reclaim` does. `_walk_size` also calls `on_progress` for every
      single entry; throttle it.

If the Tauri port goes ahead (below), 2–6 are the spec for the Rust scanner rather than
Python work: build it this way from the start instead of fixing Python and then porting.

## Decision: finish the Tauri migration?

History: Tauri + Rust was merged into `main` on 2026-03-10 (`c801810`) and removed on
2026-03-15 (`529f939`, along with `TAURI_MIGRATION_PLAN.md`). It lives on in
`worktree-tauri-migration` (last touched 2026-04-07): ~1,050 lines of Rust with some commands
still stubbed (`update_snapshot`, `select_directory`). Since then `main` has gained the backend
supervisor, the du-hast-much redesign, comparison work, tips and the `di` CLI.

Where the pain actually comes from:

| Pain | Cause | Fixed by Tauri alone? | Fixed by Tauri + Rust backend? |
|---|---|---|---|
| 289 MB app (255 MB is Electron's Chromium) | Electron | yes (~10–15 MB shell) | yes |
| Packaging the backend: PyInstaller, quarantine stripping, 27 MB unpack on every launch, 120s ready timeout, port search, 383-line supervisor | Python sidecar | **no**: Tauri would still need the same sidecar | **yes**: one binary, no ports, no HTTP |
| Idle RAM of a second browser engine | Electron | yes | yes |
| Scanner memory / wrong sizes | Scanner design | no | only if the Rust scanner is designed right |

Recommendation: yes, but only as **Tauri + Rust backend**. Switching the shell alone keeps
the worst packaging pain. Suggested order:

- [ ] Fix item 1 in Python now (tiny, user-visible).
- [ ] Write the Rust core as a library crate (`core/`): walker (per-folder aggregation,
      lstat, inode dedupe, blocks, parallel walk), findings, compare, SQLite snapshots.
- [ ] Tauri commands call the crate directly; the React UI switches from `api.ts` HTTP to
      `invoke()` behind the same function signatures, so components don't change.
- [ ] `di` stays Python for now (it's fast enough and has no packaging problem). Later it
      could become a thin Rust binary over the same crate.
- [ ] Port features in order of use: scan + findings → du-hast-much → snapshots → compare
      → tips. Keep Electron building until the Tauri build reaches parity, then remove
      `frontend/electron/`, `backend/main.py` and the PyInstaller spec.
- [ ] Reuse from the branch where it fits (commands, models, Diesel schema), but fix its scanner
      (`WalkDir` + per-file `Vec`s has the same memory shape as item 3).

## Windows parity

`di` now picks the right locations, scheduler and notifications per OS (see the README's
platform table). Everything Windows-specific was checked on macOS with a simulated
`%LOCALAPPDATA%`/`%APPDATA%` profile; none of it has run on real Windows yet.

- [ ] **Test on a real Windows machine:** `di.cmd` (py launcher / python / `DI_PYTHON`),
      `di caches` paths, `di clean` on a .NET repo, `di guard --install` (schtasks + hidden
      `pythonw` run + toast), `--uninstall`, ANSI colours in conhost and Windows Terminal,
      piped output (`di scan > out.txt`).
- [ ] Priority 1 item 1 applies to Windows too: `IGNORE_PATHS` substring matching hides any
      path containing e.g. `system volume information` or `$recycle.bin`; the fix must use
      case-insensitive *exact* prefixes on Windows (`os.path.normcase`).
- [ ] `walker.py` prune list is POSIX-only (`/System/Volumes`, `/dev` …). Add Windows
      equivalents (`C:\Windows\WinSxS`, `C:\$Recycle.Bin`, `pagefile.sys`/`hiberfil.sys` handling)
      so `di scan C:\` stays fast and doesn't double-count.
- [ ] Windows size accuracy: `st_blocks` doesn't exist there, so sizes are apparent sizes.
      NTFS-compressed and OneDrive placeholder files are overcounted; use
      `GetCompressedFileSizeW` via ctypes, and skip cloud-only placeholders (`FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`).
- [ ] Hard-link dedupe doesn't work on Windows: `DirEntry.stat()` returns `st_ino = 0` there. Call
      `os.stat()` for files with `st_nlink > 1`, or skip dedupe on Windows.
- [ ] `di tips` could include a live "top system files" line on Windows (sizes of
      `hiberfil.sys`, `pagefile.sys`, `C:\Windows\SoftwareDistribution`), as the macOS tips do
      for snapshots/swap commands.
- [ ] App: `npm run dev` uses `python3`; on Windows it's `npm run dev:win`. Consider a small
      Node launcher that picks the right Python so one command works everywhere.
- [ ] Tauri port: Windows needs WebView2 (bundled with Windows 11; use the bootstrapper for 10)
      and would drop the PyInstaller + Defender false-positive pain the sidecar has on Windows.

## Bugs

- [ ] **Backend tests don't run.** `test_path_validator.py` (unclosed paren, line 123) and
      `test_performance.py` (`//` comment, line 271) have syntax errors; 4 tests fail and
      1 errors in `test_integration_security.py`. PHASE5_COMPLETE.md reports these as done.
- [ ] **Frontend security tests can't run.** `frontend/src/tests/security/frontend-security.test.ts`
      exists but there's no vitest dependency or `test` script.
- [ ] Pre-existing TypeScript errors: `App.tsx` (Snapshot vs ComparisonSnapshot types around
      lines 256–284), unused import in `DuHastMuch.tsx`. `vite build` still succeeds.
- [ ] Stray file `frontend/src-tauri/sqlite:disk_intelligence.db`, created by a SQLite URL
      used as a literal path. Delete it along with the leftover `frontend/src-tauri/gen/`.

## Performance (after Priority 1)

- [ ] A parallel walk (Rust `jwalk`/rayon, or macOS `getattrlistbulk`). Expected gain
      ~2–3× over `du`; comes free with the Rust core if the Tauri port goes ahead.

## Features

- [ ] App: show `di caches` / `di clean` results (read-only list + "copy command"), and the
      guard's free-space history as a small chart.
- [ ] App: "System Data" explainer panel: local snapshots (`tmutil listlocalsnapshots /`),
      swap size, sleepimage, purgeable vs free.
- [ ] `di caches`: show Docker's real usage (`docker system df`) rather than the sparse
      `Docker.raw` size.
- [ ] `di guard`: detect sudden growth between readings (e.g. >5 GB in 2h) and name the folder
      via a quick `di recent`.
- [ ] `di clean`: `--interactive` picker (a TUI) for choosing projects.
- [ ] `di` install script (`scripts/install-cli.sh`) that symlinks into `~/.local/bin`.
- [ ] TODOs already in `App.tsx`: treemap, disk-change timeline, custom detection rules UI.

## Security (open items from the audit docs)

- [ ] **CRITICAL-002: database encryption** was planned (Phase 2.3) and `security/encryption.py`
      exists, but `database.py` never uses it; snapshots are stored in plaintext SQLite.
      Either wire it in or record the decision to accept the risk in THREAT_MODEL.md.
- [ ] HIGH-001 rate limiting and HIGH-004 authentication: still none. Any local process can
      call the API on 127.0.0.1. Consider a per-launch token passed from Electron to the backend.
- [ ] Electron hardening (PHASE4 "pending"): `contextIsolation` and navigation guards are in
      place now, but `webPreferences` doesn't set `sandbox: true`. Add it (check that the
      preload still works), then update PHASE4_COMPLETE.md.
- [ ] Phases 6–7 of SECURITY_AUDIT_PLAN.md (CI security gates, dependency scanning, secret
      scanning, SECURITY.md / privacy policy) not started.
- [ ] MEDIUM-004: pin dependency versions (`requirements.txt` uses `>=`).

## Build & packaging

- [ ] Rebuild the backend so the PyInstaller bundle includes `diskcli/` (added to the spec
      for `/api/tips`), then run `npm run verify`.
- [ ] BUILD.md mentions `npm run dist:linux`, which doesn't exist in `frontend/package.json`.
- [ ] `run-dev.sh` says the backend is on port 8000; it's 8001.

## Docs cleanup

- [ ] `backend/TELEMETRY_AUDIT.md` = `TELEMETRY_AUDIT_REPORT.md` and
      `frontend/TELEMETRY_AUDIT.md` = `NODE_TELEMETRY_AUDIT_REPORT.md` (byte-identical). Keep one of each.
- [ ] Move the 14 root-level audit/phase docs into `docs/security/` and link them from the README.
- [ ] Date mismatch: PHASE1_COMPLETE.md and VULNERABILITY_REPORT.md say 2025-03-09; the audit
      reports say 2026-03-09.
- [ ] Update VULNERABILITY_REPORT.md statuses (only MEDIUM-001 is marked resolved, though
      Phases 2–4 resolved several CRITICALs).
- [ ] `frontend/README.md` is the Vite template boilerplate; replace or delete it.
