"""
Maintenance commands: actually giving space back, and keeping it.

    di clean   [path]   project build junk (node_modules, __pycache__, ...)
    di caches           package-manager / IDE / toolchain caches outside projects
    di guard            free-space watchdog, installable as a launchd agent
    di ballast          a reserve file you can drop when the disk fills up

Everything here is dry-run unless --yes is passed (guard --auto aside, which
only touches entries marked auto-safe).
"""

from __future__ import annotations

import ast
import json
import os
import plistlib
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass

from . import render as r
from . import store
from .walker import DEFAULT_EXCLUDES

HOME = os.path.expanduser("~")
GB = 1 << 30


# ---------------------------------------------------------------------------
# sizing / deletion primitives
# ---------------------------------------------------------------------------

def disk_bytes(path: str) -> tuple[int, float]:
    """Allocated bytes under `path` (like `du`) and the newest mtime seen."""
    total, newest = 0, 0.0
    seen: set = set()
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            it = os.scandir(current)
        except OSError:
            continue
        with it:
            for entry in it:
                try:
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if st.st_nlink > 1 and not entry.is_dir(follow_symlinks=False):
                    key = (st.st_dev, st.st_ino)
                    if key in seen:
                        continue
                    seen.add(key)
                total += getattr(st, "st_blocks", 0) * 512 or st.st_size
                if st.st_mtime > newest:
                    newest = st.st_mtime
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
    return total, newest


def _within(path: str, parent: str) -> bool:
    path = os.path.normcase(os.path.realpath(path))
    parent = os.path.normcase(os.path.realpath(parent))
    return path == parent or path.startswith(parent.rstrip(os.sep) + os.sep)


# Keep console windows from flashing when the guard runs under pythonw on Windows.
_NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def remove_tree(path: str) -> None:
    if os.path.islink(path) or not os.path.isdir(path):
        os.unlink(path)
    else:
        shutil.rmtree(path, ignore_errors=True)


def empty_dir(path: str) -> None:
    """Delete a directory's contents but keep the directory (apps expect it)."""
    try:
        entries = list(os.scandir(path))
    except OSError:
        return
    for entry in entries:
        try:
            remove_tree(entry.path)
        except OSError:
            pass


def free_bytes(path: str = HOME) -> int:
    return shutil.disk_usage(path).free


def _app_dir() -> str:
    path = os.path.dirname(store.default_db_path())
    os.makedirs(path, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# project junk — the old clear_node_modules_pycache.sh, grown up
# ---------------------------------------------------------------------------

def _has_sibling(*names: str):
    return lambda path: any(os.path.exists(os.path.join(os.path.dirname(path), n)) for n in names)


def _has_sibling_ext(*exts: str):
    def check(path: str) -> bool:
        try:
            return any(e.name.endswith(exts) for e in os.scandir(os.path.dirname(path)))
        except OSError:
            return False
    return check


def _contains(name: str):
    return lambda path: os.path.exists(os.path.join(path, name))


# name -> (group, validator). A folder only counts if the validator agrees,
# so a hand-written `build/` or `target/` folder is never mistaken for output.
PROJECT_JUNK = {
    "node_modules": ("node", None),
    ".next": ("web", None),
    ".nuxt": ("web", None),
    ".turbo": ("web", None),
    ".parcel-cache": ("web", None),
    ".svelte-kit": ("web", None),
    ".angular": ("web", None),
    ".vite": ("web", None),
    "__pycache__": ("python", None),
    ".pytest_cache": ("python", None),
    ".mypy_cache": ("python", None),
    ".ruff_cache": ("python", None),
    ".tox": ("python", None),
    ".venv": ("venv", _contains("pyvenv.cfg")),
    "venv": ("venv", _contains("pyvenv.cfg")),
    "target": ("build", _has_sibling("Cargo.toml", "pom.xml")),
    "build": ("build", _has_sibling("package.json", "pyproject.toml", "setup.py", "build.gradle", "CMakeLists.txt")),
    "dist": ("build", _has_sibling("package.json", "pyproject.toml", "setup.py")),
    "DerivedData": ("build", None),
    "bin": ("build", _has_sibling_ext(".csproj", ".fsproj", ".vbproj")),
    "obj": ("build", _has_sibling_ext(".csproj", ".fsproj", ".vbproj")),
}
DEFAULT_GROUPS = {"node", "web", "python"}
ALL_GROUPS = {g for g, _ in PROJECT_JUNK.values()}


@dataclass
class Junk:
    path: str
    name: str
    group: str
    project: str
    size: int = 0
    project_touched: float = 0.0


def _project_touched(project: str, skip: set[str]) -> float:
    """Newest mtime among a project's top-level entries, ignoring junk dirs.
    Cheap proxy for 'when did I last work on this'."""
    newest = 0.0
    try:
        for entry in os.scandir(project):
            if entry.name in skip:
                continue
            try:
                newest = max(newest, entry.stat(follow_symlinks=False).st_mtime)
            except OSError:
                pass
    except OSError:
        pass
    return newest


def find_project_junk(root: str, groups: set[str]) -> list[Junk]:
    wanted = {n: v for n, v in PROJECT_JUNK.items() if v[0] in groups}
    found: list[Junk] = []
    for dirpath, dirnames, _ in os.walk(root, followlinks=False):
        keep = []
        for d in dirnames:
            full = os.path.join(dirpath, d)
            if d in DEFAULT_EXCLUDES or d == ".git" or os.path.islink(full):
                continue
            spec = wanted.get(d)
            if spec and (spec[1] is None or spec[1](full)):
                found.append(Junk(full, d, spec[0], dirpath))
                continue  # never descend into a match (skips nested node_modules)
            keep.append(d)
        dirnames[:] = keep
    return found


def _top_project(path: str, root: str) -> str:
    rel = os.path.relpath(path, root)
    first = rel.split(os.sep, 1)[0]
    return os.path.join(root, first) if first not in (".", "") else root


def cmd_clean(args) -> int:
    root = os.path.abspath(os.path.expanduser(args.path))
    groups = ALL_GROUPS if args.all else set(args.kinds.split(",")) if args.kinds else DEFAULT_GROUPS
    unknown = groups - ALL_GROUPS
    if unknown:
        r.error(f"unknown kind(s): {', '.join(sorted(unknown))} — choose from {', '.join(sorted(ALL_GROUPS))}")
        return 2

    spinner = r.Spinner(f"looking for build junk in {r.truncate_path(root, 50)}")
    spinner.tick()
    junk = find_project_junk(root, groups)
    now = time.time()
    for j in junk:
        spinner.tick(r.truncate_path(j.path, 50))
        j.size, _ = disk_bytes(j.path)
        j.project_touched = _project_touched(j.project, set(PROJECT_JUNK))
    spinner.done()

    cutoff = now - args.older_than * 86400 if args.older_than else None
    skipped_active = [j for j in junk if cutoff and j.project_touched > cutoff]
    targets = [j for j in junk if j not in skipped_active and j.size >= args.min_bytes]
    total = sum(j.size for j in targets)

    if args.json:
        print(json.dumps({
            "root": root, "reclaimable_bytes": total, "deleted": bool(args.yes),
            "items": [j.__dict__ for j in sorted(targets, key=lambda j: -j.size)],
            "skipped_active": [j.path for j in skipped_active],
        }, indent=2))
        if not args.yes:
            return 0
    else:
        # Grouped by top-level project, biggest first — same shape as the old script.
        by_project: dict[str, list[Junk]] = {}
        for j in targets:
            by_project.setdefault(_top_project(j.path, root), []).append(j)

        print()
        print(r.header("Project build junk", f"{r.truncate_path(root, 50)} · kinds: {', '.join(sorted(groups))}"))
        print(r.rule())
        if not targets:
            r.note("nothing to clean")
        else:
            width = min(r.term_width(), 120)
            print(f"{r.DIM}  {'SIZE':>9}  {'WORKED ON':>10}  {'WHAT':<28} PROJECT{r.RESET}")
            for project, items in sorted(by_project.items(), key=lambda kv: -sum(j.size for j in kv[1])):
                size = sum(j.size for j in items)
                touched = max(j.project_touched for j in items)
                kinds: dict[str, int] = {}
                for j in items:
                    kinds[j.name] = kinds.get(j.name, 0) + 1
                what = ", ".join(f"{n}×{c}" if c > 1 else n for n, c in sorted(kinds.items()))
                if len(what) > 28:
                    what = what[:27] + "…"
                print(
                    f"  {r.human_size(size):>9}"
                    f"  {r.DIM}{r.human_age(touched):>10}{r.RESET}"
                    f"  {r.CYAN}{what:<28}{r.RESET} "
                    f"{r.truncate_path(project, max(20, width - 56), root)}"
                )
            print()
            print(f"  {r.BOLD}{r.human_size(total)}{r.RESET} in {len(targets)} folder(s)")
        if skipped_active:
            r.note(f"skipped {len(skipped_active)} folder(s) in projects touched within {args.older_than:g} days")

    if not targets:
        return 0
    if not args.yes:
        if not args.json:
            r.note("dry run — nothing deleted. Re-run with --yes to delete.")
        return 0

    before = free_bytes(root)
    for j in targets:
        if not _within(j.path, root) or os.path.basename(j.path) not in PROJECT_JUNK:
            continue
        remove_tree(j.path)
    gained = free_bytes(root) - before
    if not args.json:
        print(f"  {r.GREEN}✓{r.RESET} deleted — free space {r.human_size(gained, signed=True)}")
    return 0


# ---------------------------------------------------------------------------
# global dev caches — the macOS equivalent of %APPDATA%/%LOCALAPPDATA% junk
# ---------------------------------------------------------------------------

@dataclass
class Cache:
    name: str
    paths: tuple[str, ...]
    # Preferred cleanup: the tool's own command, if the tool is installed.
    command: tuple[str, ...] | None = None
    # auto: safe to purge unattended (pure download/build caches).
    auto: bool = True
    note: str = ""

    def existing(self) -> list[str]:
        out = []
        for p in self.paths:
            full = _expand(p)
            if full and os.path.isdir(full) and not os.path.islink(full):
                out.append(full)
        return out


def _expand(p: str) -> str | None:
    """
    Resolve a catalog path. `%LOCALAPPDATA%/x` and `%APPDATA%/x` are Windows
    locations; anything else is relative to the home folder. A path whose
    variable isn't set on this OS resolves to None and is skipped, so one
    catalog serves macOS, Windows and Linux.
    """
    if p.startswith("%"):
        var, _, rest = p[1:].partition("%")
        base = os.environ.get(var)
        return os.path.join(base, *rest.strip("/").split("/")) if base else None
    return os.path.join(HOME, *p.split("/"))


_LIB = "Library/Caches"                 # macOS
_AS = "Library/Application Support"     # macOS
_LAD = "%LOCALAPPDATA%"                 # Windows
_RAD = "%APPDATA%"                      # Windows (roaming)
_EDITOR_CACHE_DIRS = ("Cache", "CachedData", "CachedExtensionVSIXs", "Code Cache", "GPUCache",
                      "DawnGraphiteCache", "DawnWebGPUCache", "logs", "Service Worker/CacheStorage")
_EDITORS = ("Code", "Cursor", "VSCodium", "Windsurf")

CACHES: list[Cache] = [
    Cache("npm", (".npm/_cacache", f"{_LAD}/npm-cache/_cacache"), ("npm", "cache", "clean", "--force")),
    Cache("yarn", (f"{_LIB}/Yarn", ".yarn/berry/cache", ".cache/yarn", f"{_LAD}/Yarn/Cache"),
          ("yarn", "cache", "clean")),
    Cache("pnpm store", ("Library/pnpm/store", ".pnpm-store", ".local/share/pnpm/store", f"{_LAD}/pnpm/store"),
          ("pnpm", "store", "prune")),
    Cache("bun", (".bun/install/cache",), ("bun", "pm", "cache", "rm")),
    Cache("node-gyp headers", (f"{_LIB}/node-gyp", ".node-gyp", ".cache/node-gyp", f"{_LAD}/node-gyp/Cache")),
    Cache("electron downloads", (f"{_LIB}/electron", f"{_LIB}/electron-builder", ".cache/electron",
                                 f"{_LAD}/electron/Cache", f"{_LAD}/electron-builder/Cache")),
    Cache("pip", (f"{_LIB}/pip", ".cache/pip", f"{_LAD}/pip/Cache")),
    Cache("uv", (f"{_LIB}/uv", ".cache/uv", f"{_LAD}/uv/cache"), ("uv", "cache", "clean")),
    Cache("poetry", (f"{_LIB}/pypoetry", ".cache/pypoetry", f"{_LAD}/pypoetry/Cache")),
    Cache("cargo registry", (".cargo/registry/cache", ".cargo/registry/src", ".cargo/git/checkouts")),
    Cache("go build cache", (f"{_LIB}/go-build", ".cache/go-build", f"{_LAD}/go-build"), ("go", "clean", "-cache")),
    Cache("gradle", (".gradle/caches", ".gradle/wrapper/dists")),
    Cache("NuGet HTTP cache", (".local/share/NuGet/v3-cache", f"{_LAD}/NuGet/v3-cache", f"{_LAD}/NuGet/Cache"),
          ("dotnet", "nuget", "locals", "http-cache", "--clear")),
    Cache("Homebrew downloads", (f"{_LIB}/Homebrew",), ("brew", "cleanup", "-s", "--prune=all")),
    Cache("Scoop downloads", ("scoop/cache",), ("scoop", "cache", "rm", "*")),
    Cache("CocoaPods", (f"{_LIB}/CocoaPods",)),
    Cache("Xcode DerivedData", ("Library/Developer/Xcode/DerivedData",)),
    Cache("Simulator caches", ("Library/Developer/CoreSimulator/Caches",)),
    Cache("JetBrains caches", (f"{_LIB}/JetBrains", ".cache/JetBrains", f"{_LAD}/JetBrains")),
    Cache("editor caches (VS Code / Cursor / VSCodium / Windsurf)", tuple(
        f"{base}/{app}/{d}" for base in (_AS, _RAD, ".config") for app in _EDITORS for d in _EDITOR_CACHE_DIRS
    ), note="quit the editor first for a clean result"),
    Cache("app updater leftovers", tuple(
        f"{_LIB}/{d}" for d in ("com.vscodium.ShipIt", "com.microsoft.VSCode.ShipIt",
                                "com.todesktop.230313mzl4w4u92.ShipIt", "com.exafunction.windsurf.ShipIt")
    ) + tuple(f"{_LAD}/{d}" for d in ("cursor-updater", "vscodium-updater", "windsurf-updater",
                                      "Microsoft/vscode-cpptools"))),
    Cache("user logs", ("Library/Logs", f"{_LAD}/CrashDumps")),
    Cache("Windows temp files", (f"{_LAD}/Temp",),
          note="files in use are skipped; that's expected"),
    # Not auto: re-downloading these is slow or they hold real state.
    Cache("maven repository", (".m2/repository",), auto=False),
    Cache("NuGet packages", (".nuget/packages",), auto=False,
          note="every restored package; `dotnet nuget locals global-packages --clear`"),
    Cache("Playwright browsers", (f"{_LIB}/ms-playwright", ".cache/ms-playwright", f"{_LAD}/ms-playwright"),
          auto=False),
    Cache("Cypress binaries", (f"{_LIB}/Cypress", ".cache/Cypress", f"{_LAD}/Cypress/Cache"), auto=False),
    Cache("iOS DeviceSupport", ("Library/Developer/Xcode/iOS DeviceSupport",), auto=False),
    Cache("Hugging Face / torch models", (".cache/huggingface", ".cache/torch"), auto=False,
          note="model weights; re-downloading can be many GB"),
    Cache("nvm node versions", (".nvm/versions/node", f"{_RAD}/nvm"), auto=False,
          note="use `nvm uninstall <ver>` for versions you no longer need"),
    Cache("Docker disk image", ("Library/Containers/com.docker.docker/Data/vms", f"{_LAD}/Docker/wsl"),
          ("docker", "system", "prune", "-f"), auto=False,
          note="prune frees space inside Docker; see `di tips` for shrinking the disk image itself"),
]


def _measure_caches(only_auto: bool = False) -> list[dict]:
    rows = []
    spinner = r.Spinner("measuring caches")
    for c in CACHES:
        if only_auto and not c.auto:
            continue
        paths = c.existing()
        if not paths:
            continue
        spinner.tick(c.name)
        size, newest = 0, 0.0
        for p in paths:
            s, n = disk_bytes(p)
            size += s
            newest = max(newest, n)
        rows.append({"cache": c, "name": c.name, "paths": paths, "size": size,
                     "newest": newest, "auto": c.auto, "note": c.note})
    spinner.done()
    rows.sort(key=lambda row: -row["size"])
    return rows


def clean_cache(c: Cache, paths: list[str]) -> str:
    """Clean one cache. Returns how it was done."""
    exe = shutil.which(c.command[0]) if c.command else None
    if exe:
        try:
            subprocess.run([exe, *c.command[1:]], check=True, timeout=600,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **_NO_WINDOW)
            return " ".join(c.command)
        except (subprocess.SubprocessError, OSError):
            pass  # fall back to deleting the files
    for p in paths:
        if _within(p, HOME) and os.path.realpath(p) != os.path.realpath(HOME):
            empty_dir(p)
    return "deleted contents"


def cmd_caches(args) -> int:
    rows = _measure_caches()
    rows = [row for row in rows if row["size"] >= args.min_bytes]
    selected = [row for row in rows if row["auto"] or args.include_all]
    if args.only:
        wanted = {w.strip().lower() for w in args.only.split(",")}
        selected = [row for row in rows if any(w in row["name"].lower() for w in wanted)]

    if args.json:
        print(json.dumps({
            "free_bytes": free_bytes(),
            "caches": [{k: v for k, v in row.items() if k != "cache"} for row in rows],
        }, indent=2))
        if not args.yes:
            return 0
    else:
        print()
        print(r.header("Developer caches", f"free now: {r.human_size(free_bytes())}"))
        print(r.rule())
        if not rows:
            r.note("no known caches above the threshold")
            return 0
        width = min(r.term_width(), 120)
        print(f"{r.DIM}  {'SIZE':>9}  {'USED':>9}  {'AUTO':<4}  CACHE{r.RESET}")
        for row in rows:
            mark = f"{r.GREEN}yes {r.RESET}" if row["auto"] else f"{r.DIM}no  {r.RESET}"
            chosen = "" if row in selected else f" {r.DIM}(skipped){r.RESET}"
            print(f"  {r.human_size(row['size']):>9}  {r.DIM}{r.human_age(row['newest']):>9}{r.RESET}"
                  f"  {mark}  {row['name']}{chosen}")
            if row["note"] and args.verbose:
                print(f"  {'':>9}  {'':>9}  {'':<4}  {r.DIM}↳ {row['note']}{r.RESET}")
            if args.verbose:
                for p in row["paths"]:
                    print(f"  {'':>9}  {'':>9}  {'':<4}  {r.DIM}{r.truncate_path(p, width - 30)}{r.RESET}")
        total = sum(row["size"] for row in selected)
        print()
        print(f"  {r.BOLD}{r.human_size(total)}{r.RESET} selected "
              f"{r.DIM}(AUTO=yes entries; add --include-all or --only name,name){r.RESET}")

    if not args.yes:
        if not args.json:
            r.note("dry run — nothing deleted. Re-run with --yes to clean the selected caches.")
        return 0

    before = free_bytes()
    for row in selected:
        how = clean_cache(row["cache"], row["paths"])
        if not args.json:
            print(f"  {r.GREEN}✓{r.RESET} {row['name']} {r.DIM}({how}){r.RESET}")
    if not args.json:
        print(f"\n  free space {r.human_size(free_bytes() - before, signed=True)}")
    return 0


# ---------------------------------------------------------------------------
# ballast — reserved space you can hand back in an emergency
# ---------------------------------------------------------------------------

def ballast_path() -> str:
    return os.path.join(_app_dir(), "ballast.bin")


def ballast_size() -> int:
    try:
        st = os.stat(ballast_path())
        return getattr(st, "st_blocks", 0) * 512 or st.st_size
    except OSError:
        return 0


def release_ballast() -> int:
    size = ballast_size()
    try:
        os.unlink(ballast_path())
    except OSError:
        return 0
    return size


def cmd_ballast(args) -> int:
    path = ballast_path()
    if args.action == "release":
        freed = release_ballast()
        if freed:
            print(f"  {r.GREEN}✓{r.RESET} released {r.human_size(freed)} of ballast — free: {r.human_size(free_bytes())}")
        else:
            r.note("no ballast file to release")
        return 0

    if args.action == "set":
        if args.size is None:
            r.error("usage: di ballast set 5G")
            return 2
        current = ballast_size()
        need = args.size - current
        if need > 0 and free_bytes() - need < 2 * GB:
            r.error(f"not enough room: creating {r.human_size(need)} would leave under 2 GB free")
            return 1
        if args.size <= current:
            with open(path, "r+b") as f:
                f.truncate(args.size)
            print(f"  {r.GREEN}✓{r.RESET} ballast is {r.human_size(ballast_size())} at {path}")
            return 0
        chunk = b"\0" * (64 << 20)
        # Real zero writes, not truncate(): a sparse file reserves nothing.
        with open(path, "ab") as f:
            written = f.tell()
            while written < args.size:
                n = min(len(chunk), args.size - written)
                f.write(chunk[:n])
                written += n
            f.flush()
            os.fsync(f.fileno())
        print(f"  {r.GREEN}✓{r.RESET} ballast is {r.human_size(ballast_size())} at {path}")
        print(f"    {r.DIM}when the disk fills:  di ballast release   (di guard does this automatically){r.RESET}")
        return 0

    size = ballast_size()
    if size:
        print(f"  ballast: {r.BOLD}{r.human_size(size)}{r.RESET} reserved at {path}")
    else:
        r.note("no ballast. Reserve some with:  di ballast set 5G")
    return 0


# ---------------------------------------------------------------------------
# guard — the watchdog
# ---------------------------------------------------------------------------

LAUNCH_LABEL = "com.diskintelligence.guard"   # macOS launchd
TASK_NAME = "DiskIntelligenceGuard"          # Windows Task Scheduler


def _notify(title: str, message: str) -> None:
    """Desktop notification: Notification Center, Windows toast, or notify-send."""
    try:
        if sys.platform == "darwin":
            esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
            subprocess.run(["osascript", "-e", f'display notification "{esc(message)}" with title "{esc(title)}"'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        elif sys.platform == "win32":
            ps = lambda s: s.replace("'", "''")  # noqa: E731 — PowerShell single-quote escape
            # Borrow PowerShell's registered AppUserModelID so the toast shows
            # without installing a shortcut of our own.
            script = (
                "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;"
                "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent("
                "[Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
                "$t = $x.GetElementsByTagName('text');"
                f"$t.Item(0).AppendChild($x.CreateTextNode('{ps(title)}')) | Out-Null;"
                f"$t.Item(1).AppendChild($x.CreateTextNode('{ps(message)}')) | Out-Null;"
                "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';"
                "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show("
                "[Windows.UI.Notifications.ToastNotification]::new($x))"
            )
            subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, **_NO_WINDOW)
        elif shutil.which("notify-send"):
            subprocess.run(["notify-send", title, message], check=False)
    except OSError:
        pass


def _log(event: dict) -> None:
    event = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **event}
    with open(os.path.join(_app_dir(), "guard.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(event) + "\n")


def _guard_argv(args) -> list[str]:
    """The `di guard ...` arguments the scheduled job should run with."""
    argv = ["guard", "--warn", str(args.warn), "--critical", str(args.critical)]
    if args.auto:
        argv.append("--auto")
    for dev in args.dev or []:
        argv += ["--dev", os.path.abspath(os.path.expanduser(dev))]
    if args.dev:
        argv += ["--older-than", str(args.older_than)]
    return argv


def _backend_dir() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _plist_path() -> str:
    return os.path.join(HOME, "Library", "LaunchAgents", f"{LAUNCH_LABEL}.plist")


def _task_script_path() -> str:
    return os.path.join(_app_dir(), "guard_task.pyw")


def _install_agent(args) -> int:
    log = os.path.join(_app_dir(), "guard.log")
    if sys.platform == "darwin":
        where = _install_launchd(args, log)
    elif sys.platform == "win32":
        where = _install_schtasks(args, log)
    else:
        cmd = " ".join([f'PYTHONPATH="{_backend_dir()}"', sys.executable, "-m", "diskcli", *_guard_argv(args)])
        hours = max(1, round(args.every))
        r.note("automatic install is macOS/Windows only. Add this line with `crontab -e`:")
        print(f"\n  0 */{hours} * * * {cmd} >> {log} 2>&1\n")
        return 0
    if where is None:
        return 1
    print(f"  {r.GREEN}✓{r.RESET} guard installed — runs every {args.every:g}h")
    print(f"    {r.DIM}job: {where}{r.RESET}")
    print(f"    {r.DIM}log: {log}{r.RESET}")
    print(f"    {r.DIM}remove with:  di guard --uninstall{r.RESET}")
    return 0


def _install_launchd(args, log: str) -> str | None:
    plist = {
        "Label": LAUNCH_LABEL,
        "ProgramArguments": [sys.executable, "-m", "diskcli", *_guard_argv(args)],
        "EnvironmentVariables": {"PYTHONPATH": _backend_dir(), "NO_COLOR": "1",
                                 "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"},
        "StartInterval": int(args.every * 3600),
        "RunAtLoad": True,
        "LowPriorityIO": True,
        "Nice": 10,
        "StandardOutPath": log,
        "StandardErrorPath": log,
    }
    path = _plist_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    uid = str(os.getuid())
    subprocess.run(["launchctl", "bootout", f"gui/{uid}", path],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    with open(path, "wb") as f:
        plistlib.dump(plist, f)
    res = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", path], capture_output=True, text=True)
    if res.returncode != 0:
        r.error(f"launchctl bootstrap failed: {res.stderr.strip()}")
        return None
    return path


def _install_schtasks(args, log: str) -> str | None:
    # Task Scheduler can't set environment variables, and python.exe would
    # flash a console window every run. So write a small .pyw launcher that
    # sets up the import path and logging, and run it with pythonw.exe.
    script = _task_script_path()
    hours = min(23, max(1, round(args.every)))
    with open(script, "w", encoding="utf-8") as f:
        f.write(
            f"# every_hours={hours}\n"
            "import os, sys\n"
            f"sys.path.insert(0, {_backend_dir()!r})\n"
            "os.environ['NO_COLOR'] = '1'\n"
            f"sys.stdout = sys.stderr = open({log!r}, 'a', encoding='utf-8')\n"
            "from diskcli.__main__ import main\n"
            f"main({_guard_argv(args)!r})\n"
        )
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.exists(pythonw):
        pythonw = sys.executable
    res = subprocess.run(
        ["schtasks", "/Create", "/F", "/TN", TASK_NAME, "/SC", "HOURLY", "/MO", str(hours),
         "/TR", f'"{pythonw}" "{script}"'],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        r.error(f"schtasks failed: {(res.stderr or res.stdout).strip()}")
        return None
    subprocess.run(["schtasks", "/Run", "/TN", TASK_NAME],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return f"Task Scheduler → {TASK_NAME}"


def _uninstall_agent() -> int:
    removed = False
    if sys.platform == "darwin":
        path = _plist_path()
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", path],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if os.path.exists(path):
            os.unlink(path)
            removed = True
    elif sys.platform == "win32":
        res = subprocess.run(["schtasks", "/Delete", "/F", "/TN", TASK_NAME],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        removed = res.returncode == 0
        if os.path.exists(_task_script_path()):
            os.unlink(_task_script_path())
    else:
        r.note("remove the di guard line with `crontab -e`")
        return 0
    if removed:
        print(f"  {r.GREEN}✓{r.RESET} guard removed")
    else:
        r.note("guard was not installed")
    return 0


def cmd_guard(args) -> int:
    if args.install:
        return _install_agent(args)
    if args.uninstall:
        return _uninstall_agent()

    free = free_bytes()
    level = "ok" if free >= args.warn else "critical" if free < args.critical else "low"
    actions: list[str] = []
    recovered = 0

    if level != "ok" and args.auto:
        before = free_bytes()
        for row in _measure_caches(only_auto=True):
            if row["size"] >= 50 << 20:
                clean_cache(row["cache"], row["paths"])
                actions.append(f"{row['name']} ({r.human_size(row['size'])})")
        for dev in args.dev or []:
            root = os.path.abspath(os.path.expanduser(dev))
            cutoff = time.time() - args.older_than * 86400
            for j in find_project_junk(root, DEFAULT_GROUPS):
                if _project_touched(j.project, set(PROJECT_JUNK)) < cutoff and _within(j.path, root):
                    remove_tree(j.path)
                    actions.append(j.path)
        free = free_bytes()
        recovered = max(0, free - before)
        if actions:
            _notify("Disk Intelligence",
                    f"Low disk: cleaned caches, recovered {r.human_size(free - before)}. Free: {r.human_size(free)}")

    released = 0
    if free < args.critical:
        released = release_ballast()
        free = free_bytes()
        _notify("Disk nearly full",
                f"Only {r.human_size(free)} free."
                + (f" Released {r.human_size(released)} ballast." if released else "")
                + " Run: di caches / di clean ~/dev")
    elif level == "low" and not actions:
        _notify("Disk space low", f"{r.human_size(free)} free. Run: di caches / di clean ~/dev")

    _log({"free": free, "level": level, "cleaned": actions, "recovered": recovered,
          "ballast_released": released})

    print(f"  free: {r.BOLD}{r.human_size(free)}{r.RESET}  level: {level}"
          f"  {r.DIM}(warn < {r.human_size(args.warn)}, critical < {r.human_size(args.critical)}){r.RESET}")
    for a in actions:
        print(f"  {r.DIM}cleaned {a}{r.RESET}")
    if released:
        print(f"  {r.YELLOW}released {r.human_size(released)} ballast{r.RESET}")
    if args.history:
        _print_history(args.history)
    return 0 if level == "ok" else 1


def guard_status() -> dict:
    """
    Whether guard is scheduled, how it is configured, and what its runs have
    done lately. Read-only and quick; the `di` summary shows it.
    """
    status: dict = {"installed": False, "loaded": None, "every_hours": None, "auto": False,
                    "dev": [], "last_run": None, "actions": [], "errored": False}
    argv: list[str] = []
    if sys.platform == "darwin":
        try:
            with open(_plist_path(), "rb") as f:
                plist = plistlib.load(f)
            status["installed"] = True
            argv = plist.get("ProgramArguments", [])
            status["every_hours"] = plist.get("StartInterval", 0) / 3600 or None
            res = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LAUNCH_LABEL}"],
                                 capture_output=True, text=True, timeout=3, check=False)
            status["loaded"] = res.returncode == 0
        except (OSError, ValueError, plistlib.InvalidFileException, subprocess.SubprocessError):
            pass
    elif sys.platform == "win32":
        try:
            res = subprocess.run(["schtasks", "/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"],
                                 capture_output=True, text=True, timeout=5, check=False, **_NO_WINDOW)
            status["installed"] = status["loaded"] = res.returncode == 0
            with open(_task_script_path(), encoding="utf-8") as f:
                lines = f.read().strip().splitlines()
            argv = ast.literal_eval(lines[-1][len("main("):-1])      # main([...])
            if lines[0].startswith("# every_hours="):
                status["every_hours"] = float(lines[0].split("=", 1)[1])
        except (OSError, ValueError, IndexError, subprocess.SubprocessError):
            pass
    else:
        try:
            res = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=3, check=False)
            line = next((l for l in res.stdout.splitlines()
                         if "diskcli guard" in l and not l.lstrip().startswith("#")), None)
            if line:
                status["installed"] = status["loaded"] = True
                argv = line.split()
                hours = line.split()[1]
                status["every_hours"] = float(hours[2:]) if hours.startswith("*/") else None
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    status["auto"] = "--auto" in argv
    status["dev"] = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "--dev"]

    # Guard's own runs (the summary also writes readings here, tagged with a source).
    week_ago = time.time() - 7 * 86400
    try:
        with open(os.path.join(_app_dir(), "guard.jsonl"), encoding="utf-8") as f:
            lines = f.readlines()[-500:]
    except OSError:
        lines = []
    for line in lines:
        try:
            e = json.loads(line)
            ts = time.mktime(time.strptime(e["ts"], "%Y-%m-%dT%H:%M:%S"))
        except (ValueError, KeyError):
            continue
        if e.get("source"):
            continue
        e["when"] = ts
        status["last_run"] = e
        if ts >= week_ago and (e.get("cleaned") or e.get("ballast_released")):
            status["actions"].append(e)
    status["actions"] = status["actions"][-3:][::-1]

    # A traceback after the last normal report line in guard.log means the latest run crashed.
    try:
        with open(os.path.join(_app_dir(), "guard.log"), encoding="utf-8", errors="replace") as f:
            tail = f.readlines()[-200:]
        crash = max((i for i, l in enumerate(tail) if l.startswith("Traceback")), default=-1)
        report = max((i for i, l in enumerate(tail) if l.lstrip().startswith("free:")), default=-1)
        status["errored"] = crash > report
    except OSError:
        pass
    return status


def _print_history(n: int) -> None:
    path = os.path.join(_app_dir(), "guard.jsonl")
    try:
        with open(path) as f:
            lines = f.readlines()[-n:]
    except OSError:
        r.note("no guard history yet")
        return
    print()
    print(f"{r.DIM}  {'WHEN':<17} {'FREE':>9}  CHANGE{r.RESET}")
    prev = None
    for line in lines:
        e = json.loads(line)
        change = "" if prev is None else r.human_size(e["free"] - prev, signed=True)
        color = r.delta_color(-(e["free"] - prev)) if prev is not None else ""
        print(f"  {e['ts'][:16].replace('T', ' '):<17} {r.human_size(e['free']):>9}  {color}{change}{r.RESET}")
        prev = e["free"]
