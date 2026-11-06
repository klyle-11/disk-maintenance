"""
`di move`: what could live on another drive instead of the one that's full,
and how to move each thing without breaking the app that owns it.

Cleaning caches only goes so far. The real bulk is usually games, WSL and
Docker disks, virtual machines, emulator images, model weights, phone backups
and your own media. Most of those belong to an app with its own way to move
them (Steam's storage manager, `wsl --manage --move`, Docker's disk image
location ...); dragging the folder breaks the app. Plain data — big files and
folders nobody has touched in months — moves with robocopy or mv.

Read-only: it measures and prints the way to move each item, it never moves
anything itself.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass

from . import maint
from . import render as r
from . import summary
from .walker import ScanError, cloud_provider, local_size, scan

HOME = os.path.expanduser("~")
GB = 1 << 30
_WIN = sys.platform == "win32"


# ---------------------------------------------------------------------------
# catalogue: data that belongs to an app
# ---------------------------------------------------------------------------

@dataclass
class Movable:
    name: str
    # Catalogue paths as in `di caches`: home-relative, %VAR%/..., `*` globs.
    paths: tuple[str, ...]
    # Folder under the target drive that the instructions suggest.
    dest: str
    # How to move it. {path} the item, {dest} where it goes, {drive} the target,
    # {name} the item's own name. `how_posix` replaces it on macOS / Linux.
    how: str
    how_posix: str = ""
    # One row per child folder (one per game or VM) instead of one for the lot.
    each: bool = False
    skip: tuple[str, ...] = ()


_ENV_WIN = 'move it to "{dest}", then  setx %s "{dest}"'
_ENV_POSIX = 'mv "{path}" "{dest}"  and add  export %s="{dest}"  to your shell profile'

CATALOG: list[Movable] = [
    Movable("Epic Games", ("%ProgramFiles%/Epic Games",), "Epic Games",
            "Epic has no move button: uninstall {name} in the launcher, then install it again on {drive}",
            each=True, skip=("Launcher", "DirectXRedist")),
    Movable("Xbox / Microsoft Store games", ("%SystemDrive%/XboxGames",), "XboxGames",
            "Xbox app → right-click {name} → Manage → Files → Move → {drive}", each=True, skip=("GameSave",)),
    Movable("Docker Desktop disk", ("%LOCALAPPDATA%/Docker/wsl", "Library/Containers/com.docker.docker/Data/vms"),
            "Docker", "prune first (docker system prune -a), then Docker Desktop → Settings → Resources → "
            "Advanced → Disk image location → {dest} → Apply & restart"),
    Movable("Hyper-V disks", ("%PUBLIC%/Documents/Hyper-V/Virtual hard disks",
                              "%ProgramData%/Microsoft/Windows/Virtual Hard Disks"), "Hyper-V",
            'admin PowerShell, per VM (Get-VM lists them):  Move-VMStorage -VMName <vm> '
            '-DestinationStoragePath "{dest}\\<vm>"'),
    Movable("VirtualBox VM", ("VirtualBox VMs",), "VirtualBox VMs",
            "VirtualBox → shut {name} down → right-click it → Move… → {dest}", each=True),
    Movable("VMware VM", ("Documents/Virtual Machines", "Virtual Machines.localized"), "Virtual Machines",
            'power {name} off, move its folder into "{dest}", then File → Open its .vmx and choose “I Moved It”',
            each=True),
    Movable("Android emulator images", (".android/avd",), "Android/avd",
            _ENV_WIN % "ANDROID_AVD_HOME", _ENV_POSIX % "ANDROID_AVD_HOME"),
    Movable("Android SDK", ("%LOCALAPPDATA%/Android/Sdk", "Library/Android/sdk", "Android/Sdk"), "Android/Sdk",
            'close Android Studio, move it to "{dest}", then Settings → Languages & Frameworks → Android SDK → '
            "Edit the location (and ANDROID_HOME, if you set it)"),
    Movable("Ollama models", (".ollama/models",), "ollama/models",
            "quit Ollama, " + _ENV_WIN % "OLLAMA_MODELS" + ", start Ollama",
            "quit Ollama, " + _ENV_POSIX % "OLLAMA_MODELS"),
    Movable("LM Studio models", (".lmstudio/models", ".cache/lm-studio/models"), "lm-studio/models",
            'move it to "{dest}", then LM Studio → My Models → Models Directory → Change to it'),
    Movable("Hugging Face cache", (".cache/huggingface",), "huggingface",
            _ENV_WIN % "HF_HOME", _ENV_POSIX % "HF_HOME"),
    Movable("NuGet packages", (".nuget/packages",), "nuget/packages",
            _ENV_WIN % "NUGET_PACKAGES", _ENV_POSIX % "NUGET_PACKAGES"),
    Movable("iPhone / iPad backups", ("%APPDATA%/Apple Computer/MobileSync/Backup", "Apple/MobileSync/Backup",
                                      "Library/Application Support/MobileSync/Backup"), "MobileSync/Backup",
            'close iTunes / Apple Devices, move it to "{dest}", then  cmd /c mklink /J "{path}" "{dest}"',
            'quit Finder\'s device sync, mv "{path}" "{dest}"  then  ln -s "{dest}" "{path}"'),
]

# Windows' relocatable user folders (registry value under User Shell Folders → name).
KNOWN_FOLDERS = (
    ("{374DE290-123F-4565-9164-39C4925E467B}", "Downloads"),
    ("My Video", "Videos"),
    ("My Pictures", "Pictures"),
    ("My Music", "Music"),
    ("Personal", "Documents"),
    ("Desktop", "Desktop"),
)

DISK_IMAGE_EXTS = {".iso", ".img", ".vhd", ".vhdx", ".vmdk", ".vdi", ".qcow2", ".dmg", ".wim", ".esd"}
VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".avi", ".m4v", ".wmv", ".webm", ".mts", ".braw", ".r3d"}
ARCHIVE_EXTS = {".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".xz", ".zst", ".bz2"}
INSTALLER_EXTS = {".exe", ".msi", ".msix", ".pkg", ".appimage", ".deb", ".rpm"}


@dataclass
class Row:
    section: str          # "app", "folder", "old", "file"
    name: str
    path: str
    size: int
    touched: float
    how: str
    cloud: str | None = None


# ---------------------------------------------------------------------------
# where things are
# ---------------------------------------------------------------------------

def _drive_key(path: str):
    """What identifies the volume a path lives on."""
    if _WIN:
        return os.path.splitdrive(os.path.abspath(path))[0].upper()
    try:
        return os.stat(path).st_dev
    except OSError:
        return None


def _within(path: str, parent: str) -> bool:
    path, parent = os.path.normcase(path), os.path.normcase(parent)
    return path == parent or path.startswith(parent.rstrip(os.sep) + os.sep)


def _reg_values(hive_name: str, key: str) -> dict[str, object]:
    """All values of one registry key, {} anywhere but Windows."""
    if not _WIN:
        return {}
    try:
        import winreg  # noqa: PLC0415

        out = {}
        with winreg.OpenKey(getattr(winreg, hive_name), key) as k:
            for i in range(winreg.QueryInfoKey(k)[1]):
                name, value, _ = winreg.EnumValue(k, i)
                out[name] = value
        return out
    except OSError:
        return {}


def _reg_subkeys(hive_name: str, key: str) -> list[str]:
    if not _WIN:
        return []
    try:
        import winreg  # noqa: PLC0415

        with winreg.OpenKey(getattr(winreg, hive_name), key) as k:
            return [winreg.EnumKey(k, i) for i in range(winreg.QueryInfoKey(k)[0])]
    except OSError:
        return []


def _steam_libraries() -> list[str]:
    """Every Steam library folder (the install itself plus any added in Settings → Storage)."""
    roots = []
    steam = _reg_values("HKEY_CURRENT_USER", r"Software\Valve\Steam").get("SteamPath")
    if isinstance(steam, str):
        roots.append(os.path.normpath(steam))
    for p in ("%ProgramFiles(x86)%/Steam", "Library/Application Support/Steam", ".local/share/Steam", ".steam/steam"):
        full = maint._expand(p)
        if full:
            roots.append(full)
    libraries: list[str] = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        libraries.append(root)
        try:
            with open(os.path.join(root, "steamapps", "libraryfolders.vdf"), encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        for raw in re.findall(r'"path"\s+"((?:[^"\\]|\\.)*)"', text):
            libraries.append(os.path.normpath(raw.replace("\\\\", "\\").replace('\\"', '"')))
    seen, out = set(), []
    for lib in libraries:
        key = os.path.normcase(os.path.realpath(lib))
        if key not in seen and os.path.isdir(os.path.join(lib, "steamapps", "common")):
            seen.add(key)
            out.append(lib)
    return out


def _wsl_distros() -> list[tuple[str, str]]:
    """(distro name, .vhdx path) for each WSL 2 distro, from the registry WSL itself uses."""
    base = r"Software\Microsoft\Windows\CurrentVersion\Lxss"
    out = []
    for guid in _reg_subkeys("HKEY_CURRENT_USER", base):
        values = _reg_values("HKEY_CURRENT_USER", base + "\\" + guid)
        name, path = values.get("DistributionName"), values.get("BasePath")
        if not isinstance(name, str) or not isinstance(path, str) or name.startswith("docker-desktop"):
            continue  # Docker's own distros are the Docker Desktop row
        path = path[4:] if path.startswith("\\\\?\\") else path
        vhdx = os.path.join(path, str(values.get("VhdFileName") or "ext4.vhdx"))
        if os.path.isfile(vhdx):
            out.append((name, vhdx))
    return out


def _known_folders() -> list[tuple[str, str]]:
    """(name, path) for Downloads, Videos ... wherever they've been put (Windows only)."""
    if not _WIN:
        return []
    values = _reg_values("HKEY_CURRENT_USER", r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
    out = []
    for value, name in KNOWN_FOLDERS:
        path = values.get(value)
        path = os.path.expandvars(path) if isinstance(path, str) else os.path.join(HOME, name)
        if os.path.isdir(path):
            out.append((name, os.path.normpath(path)))
    return out


def _file_bytes(path: str) -> tuple[int, float]:
    """On-disk bytes of one file (sparse and compressed .vhdx files report less than their length)."""
    st = os.stat(path)
    if _WIN:
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        fn = kernel32.GetCompressedFileSizeW
        fn.argtypes = (wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD))
        fn.restype = wintypes.DWORD
        high = wintypes.DWORD(0)
        ctypes.set_last_error(0)
        low = fn(path, ctypes.byref(high))
        if low != 0xFFFFFFFF or ctypes.get_last_error() == 0:
            return (high.value << 32) + low, st.st_mtime
    return getattr(st, "st_blocks", 0) * 512 or local_size(st), st.st_mtime


# ---------------------------------------------------------------------------
# targets
# ---------------------------------------------------------------------------

def _pick_target(drives: list[dict], wanted: str | None) -> dict | None:
    """The drive to suggest moving to: --to if given, else the local drive with the most room."""
    if wanted:
        path = os.path.abspath(os.path.expanduser(wanted))
        usage = shutil.disk_usage(path)
        if _drive_key(path) == _drive_key(HOME):
            raise OSError("it's on the same drive as your home folder")
        match = next((d for d in drives if _drive_key(d["mount"]) == _drive_key(path)), None)
        return {"name": match["name"] if match else path, "mount": path, "type": match["type"] if match else "",
                "free": usage.free, "total": usage.total}
    local = [d for d in drives if "network" not in d["type"]]
    return max(local, key=lambda d: d["free"]) if local else None


def _drive_label(target: dict | None) -> str:
    """How instructions name the target: "D:" on Windows, the volume name elsewhere."""
    if not target:
        return "the other drive"
    if _WIN:
        return os.path.splitdrive(target["mount"])[0] or target["mount"]
    return target["name"]


def _dest_root(target: dict | None) -> str:
    if not target:
        return "<drive>"
    mount = target["mount"]
    # "D:\" → "D:" so joined paths read D:\Docker rather than D:\\Docker.
    return mount.rstrip("\\/") if _WIN and len(mount.rstrip("\\/")) == 2 else mount


# ---------------------------------------------------------------------------
# collecting rows
# ---------------------------------------------------------------------------

def _catalog_rows(dest_root: str, drive: str, on_drive, sizes) -> list[Row]:
    rows: list[Row] = []

    def add(name: str, path: str, dest_sub: str, how: str, item: str) -> None:
        if not on_drive(path):
            return
        size, touched = sizes(path)
        dest = os.path.join(dest_root, *dest_sub.split("/"))
        rows.append(Row("app", name, path, size, touched,
                        how.format(path=path, dest=dest, drive=drive, name=item)))

    for lib in _steam_libraries():
        try:
            games = sorted(os.scandir(os.path.join(lib, "steamapps", "common")), key=lambda e: e.name.lower())
        except OSError:
            continue
        for entry in games:
            if entry.is_dir(follow_symlinks=False) and entry.name != "Steamworks Shared":
                add(f"Steam: {entry.name}", entry.path, "SteamLibrary",
                    "Steam → Settings → Storage → add a library on {drive} (+), tick {name} → Move", entry.name)

    for name, vhdx in _wsl_distros():
        add(f"WSL: {name}", vhdx, f"WSL/{name}",
            'wsl --shutdown  then  wsl --manage "{name}" --move "{dest}"', name)

    for m in CATALOG:
        how = m.how_posix if m.how_posix and not _WIN else m.how
        for p in m.paths:
            full = maint._expand(p)
            if not full or not os.path.isdir(full) or os.path.islink(full):
                continue
            if not m.each:
                add(m.name, full, m.dest, how, os.path.basename(full))
                continue
            try:
                children = sorted(os.scandir(full), key=lambda e: e.name.lower())
            except OSError:
                continue
            for entry in children:
                if entry.is_dir(follow_symlinks=False) and entry.name not in m.skip:
                    add(f"{m.name}: {entry.name}", entry.path, m.dest, how, entry.name)
    return sorted(rows, key=lambda row: -row.size)


def _folder_rows(dest_root: str, drive: str, on_drive, sizes) -> list[Row]:
    rows = []
    for name, path in _known_folders():
        if not on_drive(path):
            continue
        size, touched = sizes(path)
        provider = cloud_provider(path)
        how = (f"backed up by {provider}: right-click it → Free up space, rather than moving it" if provider else
               f"File Explorer → right-click {name} → Properties → Location → Move… → "
               f"{os.path.join(dest_root, name)}")
        rows.append(Row("folder", name, path, size, touched, how, cloud=provider))
    return sorted(rows, key=lambda row: -row.size)


def _plain_move(path: str, dest_root: str, is_dir: bool) -> str:
    """robocopy / mv command that moves a plain file or folder under <drive>\\<user>\\<same place>."""
    rel = os.path.relpath(path, HOME) if _within(path, HOME) else os.path.splitdrive(path)[1].lstrip("\\/")
    dest = os.path.join(dest_root, os.path.basename(HOME), rel)
    if _WIN:
        if is_dir:
            return f'robocopy "{path}" "{dest}" /E /MOVE'
        return f'robocopy "{os.path.dirname(path)}" "{os.path.dirname(dest)}" "{os.path.basename(path)}" /MOV'
    return f'mkdir -p "{os.path.dirname(dest)}" && mv "{path}" "{os.path.dirname(dest)}/"'


def _file_kind(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    for kind, exts in (("disk image", DISK_IMAGE_EXTS), ("video", VIDEO_EXTS),
                       ("archive", ARCHIVE_EXTS), ("installer", INSTALLER_EXTS)):
        if ext in exts:
            return kind
    return ""


def _home_prune() -> list[str]:
    """Home folders that hold app state rather than your files: AppData, ~/Library, dot-folders."""
    out = []
    try:
        for entry in os.scandir(HOME):
            if entry.name.startswith(".") or entry.name in ("AppData", "Library"):
                out.append(entry.path)
    except OSError:
        pass
    return out


# ---------------------------------------------------------------------------
# di move
# ---------------------------------------------------------------------------

def cmd_move(args) -> int:
    disk = shutil.disk_usage(HOME)
    drives = summary._other_drives()
    try:
        target = _pick_target(drives, args.to)
    except OSError as exc:
        r.error(f"can't use {args.to}: {exc}")
        return 2
    dest_root = _dest_root(target)
    drive = _drive_label(target)
    home_drive = _drive_key(HOME)

    def on_drive(path: str) -> bool:
        return _drive_key(path) == home_drive

    spinner = r.Spinner("looking for what could move")
    big_files: list[tuple[str, int, float]] = []
    min_bytes = args.min_bytes

    def on_file(path: str, size: int, mtime: float) -> None:
        if size >= min_bytes:
            big_files.append((path, size, mtime))  # list.append is atomic; walker threads share it

    result = None
    if not args.quick:
        try:
            result = scan(HOME, max_depth=args.depth, recent_days=args.days, on_file=on_file, prune=_home_prune(),
                          on_progress=lambda d, t, cur: spinner.tick(f"{d}/{t}  {r.truncate_path(cur, 40)}"))
        except ScanError as exc:
            spinner.done()
            r.error(str(exc))
            return 2

    def sizes(path: str) -> tuple[int, float]:
        spinner.tick(r.truncate_path(path, 50))
        node = result.nodes.get(path) if result else None
        if node:
            return node.size, node.newest_mtime
        if os.path.isfile(path):
            return _file_bytes(path)
        return maint.disk_bytes(path)

    apps = [row for row in _catalog_rows(dest_root, drive, on_drive, sizes) if row.size >= min_bytes]
    folders = [row for row in _folder_rows(dest_root, drive, on_drive, sizes) if row.size >= min_bytes]
    claimed = [row.path for row in apps]

    old: list[Row] = []
    files: list[Row] = []
    if result:
        cutoff = time.time() - args.days * 86400
        known = [row.path for row in folders]

        def plain(path: str) -> bool:
            """Yours to move by hand: not an app's (above), not in the cloud, not build junk or git internals."""
            return not any(_within(path, c) for c in claimed) and not cloud_provider(path) and not any(
                part in maint.PROJECT_JUNK or part == ".git" for part in os.path.relpath(path, HOME).split(os.sep))

        candidates = sorted((n for n in result.nodes.values()
                             if n.depth >= 1 and n.size >= min_bytes and 0 < n.newest_mtime < cutoff
                             and plain(n.path)
                             # A folder holding Documents or a VM would be counted twice; look inside it instead.
                             and not any(_within(p, n.path) for p in known + claimed)),
                            key=lambda n: -n.size)
        for n in candidates:
            if not any(_within(n.path, o.path) for o in old):
                old.append(Row("old", os.path.basename(n.path), n.path, n.size, n.newest_mtime,
                               _plain_move(n.path, dest_root, True)))
        for path, size, mtime in sorted(big_files, key=lambda f: -f[1]):
            if plain(path) and not any(_within(path, o.path) for o in old):
                kind = _file_kind(path)
                files.append(Row("file", kind, path, size, mtime, _plain_move(path, dest_root, False)))
    spinner.done()

    sections = [("app", apps), ("folder", folders), ("old", old[: args.top]), ("file", files[: args.top])]
    everything = [row for _, rows in sections for row in rows]
    # Rows can nest (a big file inside Downloads); count each byte once.
    total = sum(row.size for row in everything
                if not any(o is not row and _within(row.path, o.path) for o in everything))

    if args.json:
        print(json.dumps({
            "drive": {"mount": os.path.splitdrive(HOME)[0] + os.sep, "free": disk.free, "total": disk.total},
            "target": target, "other_drives": drives, "movable_bytes": total,
            "items": [{"section": row.section, "name": row.name, "path": row.path, "bytes": row.size,
                       "touched": row.touched, "how": row.how, "cloud": row.cloud} for row in everything],
        }, indent=2))
        return 0

    print()
    print(r.header(f"What could move off {os.path.splitdrive(HOME)[0] or '/'}",
                   f"{r.human_size(disk.free)} free of {r.human_size(disk.total)}"))
    print(r.rule())
    if target:
        print(f"  {r.DIM}to{r.RESET}  {r.BOLD}{target['name']}{r.RESET}  {r.DIM}{target['type']}{r.RESET}  "
              f"{r.human_size(target['free'])} free")
        others = [d for d in drives if d["mount"] != target["mount"] and d["free"] >= GB]
        if others:
            r.note("      also: " + " · ".join(f"{d['name']} {r.human_size(d['free'])} free" for d in others)
                   + "  (choose with --to)")
        if _WIN and target["type"] and "NTFS" not in target["type"]:
            r.note(f"      {target['type'].split()[0]} holds plain files; WSL, Docker, Hyper-V and Xbox games need NTFS")
        if "removable" in target["type"]:
            r.note("      apps moved to a removable drive only work while it's plugged in")
    else:
        r.note("  no other drive connected: plug one in, or name a folder with --to (commands below say <drive>)")

    width = min(r.term_width(), 120)
    titles = {
        "app": ("Apps that move their own data", "use the app's own way; dragging the folder breaks it"),
        "folder": ("Your folders", "Windows moves these and keeps them working"),
        "old": (f"Untouched for {args.days:g}+ days", "plain data"),
        "file": ("Big files", "plain data"),
    }
    for key, rows in sections:
        if not rows:
            continue
        title, hint = titles[key]
        shown = [row for row in rows if not row.cloud]
        print()
        print(f"{r.BOLD}{title}{r.RESET}  {r.human_size(sum(row.size for row in shown))}  {r.DIM}{hint}{r.RESET}")
        for row in rows:
            label = r.full_path(row.path) if key in ("old", "file") else row.name
            mark = f" {r.DIM}[{row.name}]{r.RESET}" if key == "file" and row.name else ""
            if row.cloud:
                mark += f"  {r.CYAN}☁ {row.cloud}{r.RESET}"
            print(f"  {r.human_size(row.size):>9}  {r.DIM}{r.human_age(row.touched):>9}{r.RESET}  {label}{mark}")
            if key in ("app", "folder"):
                print(f"  {'':>9}  {'':>9}  {r.DIM}{r.truncate_path(r.full_path(row.path), width - 24)}{r.RESET}")
            # Plain data gets a command to paste; app data gets the app's own steps.
            prefix = f"{r.CYAN}$ " if key in ("old", "file") else f"{r.DIM}→ "
            print(f"  {'':>9}  {'':>9}  {prefix}{row.how}{r.RESET}")

    print()
    if not everything:
        r.note(f"  nothing over {r.human_size(min_bytes)} to move"
               + ("" if result else " (--quick skips your own folders)"))
        return 0
    room = f" ({r.human_size(target['free'])} free there)" if target else ""
    print(f"  {r.BOLD}≈ {r.human_size(total)}{r.RESET} could move to {drive}{room}")
    if target and total > target["free"]:
        r.warn(f"that's more than {drive} has free; pick what matters most")
    if old or files:
        r.note("  check nothing (shortcuts, projects, playlists) points at plain data before moving it"
               + ("; robocopy exit codes below 8 mean success" if _WIN else ""))
    if result is None:
        r.note("  --quick: your own folders weren't searched for old folders and big files")
    elif result.errors:
        r.note(f"  {result.errors} paths were unreadable and skipped")
    return 0
