"""
The at-a-glance summary `di` and `di help` open with.

Everything here has to stay quick (well under a second on a warm machine), so
nothing walks the disk: sizes come from statvfs, memory from the OS counters,
and "what changed lately" from data that is already lying around — the free
space readings guard (and this summary) record, saved baselines, and on macOS
the Spotlight index.
"""

from __future__ import annotations

import getpass
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from . import maint
from . import render as r
from . import store

HOME = os.path.expanduser("~")
GB = 1 << 30

# Match guard's defaults so "low" means the same thing everywhere.
WARN_FREE = 20 * GB
CRITICAL_FREE = 8 * GB

# Record at most one free-space reading per this many seconds.
READING_INTERVAL = 3600

RECENT_DAYS = 7
BIG_FILE = 500 << 20

_NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def _run(argv: list[str], timeout: float = 3.0) -> str:
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                             check=False, **_NO_WINDOW)
        return out.stdout
    except (OSError, subprocess.SubprocessError):
        return ""


# ---------------------------------------------------------------------------
# disk
# ---------------------------------------------------------------------------

def _main_volume() -> dict:
    usage = shutil.disk_usage(HOME)
    name = os.path.splitdrive(HOME)[0] or "/"
    if sys.platform == "darwin":
        try:
            for entry in os.scandir("/Volumes"):
                if os.path.realpath(entry.path) == "/":
                    name = entry.name
                    break
        except OSError:
            pass
    return {"name": name, "mount": os.path.splitdrive(HOME)[0] + os.sep,
            "total": usage.total, "used": usage.total - usage.free, "free": usage.free,
            "ballast": maint.ballast_size()}


def _usage_or_none(path: str, timeout: float = 1.5):
    """disk_usage with a timeout: a stalled network share must not hang the summary."""
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(shutil.disk_usage, path)
        try:
            return future.result(timeout=timeout)
        except Exception:
            return None


def _mount_types() -> dict[str, str]:
    """Mount point → filesystem type, from `mount` (macOS) or /proc/mounts (Linux)."""
    types: dict[str, str] = {}
    if sys.platform == "darwin":
        for line in _run(["mount"]).splitlines():
            # /dev/disk4s1 on /Volumes/STORENGO (msdos, local, ...)
            if " on " in line and " (" in line:
                point, _, rest = line.split(" on ", 1)[1].rpartition(" (")
                types[point] = rest.split(",")[0].rstrip(")")
    elif sys.platform.startswith("linux"):
        try:
            with open("/proc/mounts") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 3:
                        types[parts[1].replace("\\040", " ")] = parts[2]
        except OSError:
            pass
    return types


def _other_drives() -> list[dict]:
    """Connected volumes other than the one holding the home folder."""
    candidates: list[tuple[str, str, str]] = []  # (name, mount point, kind)

    if sys.platform == "darwin":
        types = _mount_types()
        try:
            for entry in sorted(os.scandir("/Volumes"), key=lambda e: e.name.lower()):
                if entry.name.startswith("com.apple.TimeMachine") or os.path.realpath(entry.path) == "/":
                    continue
                candidates.append((entry.name, entry.path, types.get(entry.path, "")))
        except OSError:
            pass

    elif sys.platform == "win32":
        import ctypes  # noqa: PLC0415
        import string  # noqa: PLC0415

        kernel32 = ctypes.windll.kernel32
        mask = kernel32.GetLogicalDrives()
        home_drive = os.path.splitdrive(HOME)[0].upper()
        kinds = {2: "removable", 3: "fixed", 4: "network", 5: "optical", 6: "ramdisk"}
        for i, letter in enumerate(string.ascii_uppercase):
            if not mask & (1 << i) or f"{letter}:" == home_drive:
                continue
            root = f"{letter}:\\"
            kind = kinds.get(kernel32.GetDriveTypeW(root), "")
            if kind == "optical":
                continue
            label = ctypes.create_unicode_buffer(261)
            fs = ctypes.create_unicode_buffer(261)
            kernel32.GetVolumeInformationW(root, label, 261, None, None, None, fs, 261)
            name = f"{letter}: {label.value}".strip()
            candidates.append((name, root, " ".join(filter(None, (fs.value, kind)))))

    else:
        home_dev = os.stat(HOME).st_dev
        seen: set[int] = {home_dev}
        for point, fstype in _mount_types().items():
            if not point.startswith(("/media/", "/mnt/", "/run/media/")) and not (
                fstype in ("ext4", "ext3", "xfs", "btrfs", "ntfs", "ntfs3", "vfat", "exfat", "zfs")
                and point not in ("/", "/boot", "/boot/efi", "/boot/firmware")
            ):
                continue
            try:
                dev = os.stat(point).st_dev
            except OSError:
                continue
            if dev in seen:
                continue
            seen.add(dev)
            candidates.append((os.path.basename(point) or point, point, fstype))

    drives = []
    for name, point, kind in candidates:
        usage = _usage_or_none(point)
        if usage is None or usage.total == 0:
            continue
        drives.append({"name": name, "mount": point, "type": kind,
                       "total": usage.total, "used": usage.total - usage.free, "free": usage.free})
    return drives


# ---------------------------------------------------------------------------
# memory
# ---------------------------------------------------------------------------

def _memory() -> dict:
    mem = {"total": 0, "used": 0, "swap_used": 0, "swap_total": 0}
    if sys.platform == "darwin":
        mem["total"] = int(_run(["sysctl", "-n", "hw.memsize"]).strip() or 0)
        stats: dict[str, int] = {}
        page = 4096
        for line in _run(["vm_stat"]).splitlines():
            if "page size of" in line:
                page = int(line.split("page size of")[1].split()[0])
            key, _, value = line.partition(":")
            if value.strip().rstrip(".").isdigit():
                stats[key.strip()] = int(value.strip().rstrip("."))
        # Activity Monitor's "Memory Used": app memory + wired + compressed.
        app = stats.get("Anonymous pages", 0) - stats.get("Pages purgeable", 0)
        mem["used"] = (app + stats.get("Pages wired down", 0)
                       + stats.get("Pages occupied by compressor", 0)) * page
        swap = _run(["sysctl", "-n", "vm.swapusage"]).split()
        # total = 4096.00M  used = 3155.62M  free = 940.38M
        for key in ("total", "used"):
            if key in swap:
                mem[f"swap_{key}"] = _size_token(swap[swap.index(key) + 2])
    elif sys.platform == "win32":
        import ctypes  # noqa: PLC0415

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        status = MEMORYSTATUSEX()
        status.dwLength = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            mem["total"] = status.ullTotalPhys
            mem["used"] = status.ullTotalPhys - status.ullAvailPhys
            # The commit limit minus RAM is what the page file adds.
            mem["swap_total"] = max(0, status.ullTotalPageFile - status.ullTotalPhys)
            mem["swap_used"] = max(0, (status.ullTotalPageFile - status.ullAvailPageFile) - mem["used"])
    else:
        info: dict[str, int] = {}
        try:
            with open("/proc/meminfo") as f:
                for line in f:
                    key, _, value = line.partition(":")
                    info[key] = int(value.split()[0]) * 1024
        except (OSError, ValueError, IndexError):
            pass
        mem["total"] = info.get("MemTotal", 0)
        mem["used"] = mem["total"] - info.get("MemAvailable", 0)
        mem["swap_total"] = info.get("SwapTotal", 0)
        mem["swap_used"] = mem["swap_total"] - info.get("SwapFree", 0)
    return mem


def _size_token(token: str) -> int:
    """'3155.62M' → bytes."""
    units = {"K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}
    try:
        if token[-1] in units:
            return int(float(token[:-1]) * units[token[-1]])
        return int(float(token))
    except (ValueError, IndexError):
        return 0


def _app_name(command: str) -> str:
    """Fold helper processes into their app: '/A/Vivaldi.app/.../Vivaldi Helper' → 'Vivaldi'."""
    if ".app/" in command:
        return os.path.basename(command.split(".app/")[0])
    name = os.path.basename(command)
    return name[:-4] if name.lower().endswith(".exe") else name


def _memory_users(limit: int = 5) -> list[dict]:
    """Biggest resident-memory users, grouped by app. RSS double-counts shared pages; it's a ranking."""
    totals: dict[str, int] = {}
    counts: dict[str, int] = {}
    if sys.platform == "win32":
        import csv  # noqa: PLC0415
        import io  # noqa: PLC0415

        for row in csv.reader(io.StringIO(_run(["tasklist", "/fo", "csv", "/nh"]))):
            if len(row) >= 5:
                kb = "".join(ch for ch in row[4] if ch.isdigit())
                if kb:
                    name = _app_name(row[0])
                    totals[name] = totals.get(name, 0) + int(kb) * 1024
                    counts[name] = counts.get(name, 0) + 1
    else:
        for line in _run(["ps", "-axo", "rss=,comm="] if sys.platform == "darwin"
                         else ["ps", "-eo", "rss=,comm="]).splitlines():
            rss, _, command = line.strip().partition(" ")
            if rss.isdigit():
                name = _app_name(command.strip())
                totals[name] = totals.get(name, 0) + int(rss) * 1024
                counts[name] = counts.get(name, 0) + 1
    top = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:limit]
    return [{"name": n, "bytes": b, "processes": counts[n]} for n, b in top]


# ---------------------------------------------------------------------------
# what changed lately
# ---------------------------------------------------------------------------

def _readings_path() -> str:
    return os.path.join(maint._app_dir(), "guard.jsonl")


def _load_readings() -> list[tuple[float, int]]:
    readings = []
    try:
        with open(_readings_path(), encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                    ts = time.mktime(time.strptime(e["ts"], "%Y-%m-%dT%H:%M:%S"))
                    readings.append((ts, int(e["free"])))
                except (ValueError, KeyError):
                    continue
    except OSError:
        pass
    return readings


def _record_reading(free: int, readings: list[tuple[float, int]]) -> None:
    """Add to guard's free-space log so trends build up even without guard installed."""
    if readings and time.time() - readings[-1][0] < READING_INTERVAL:
        return
    try:
        maint._log({"free": free, "source": "summary"})
    except OSError:
        pass


def _free_trend(free_now: int, readings: list[tuple[float, int]]) -> list[dict]:
    """Change in free space over the last day and week, from the closest older reading."""
    now = time.time()
    trend = []
    for label, span in (("since yesterday", 86400), ("this week", 7 * 86400)):
        older = [(ts, free) for ts, free in readings if now - ts >= span * 0.5 and now - ts <= span * 1.5]
        if not older:
            continue
        ts, free = min(older, key=lambda x: abs((now - x[0]) - span))
        trend.append({"label": label, "since": ts, "delta": free_now - free})
    # Biggest single drop between consecutive readings in the last week.
    week = [x for x in readings if now - x[0] <= 7 * 86400]
    drops = [(b[0], b[1] - a[1]) for a, b in zip(week, week[1:])]
    if drops:
        ts, delta = min(drops, key=lambda d: d[1])
        if delta < -1 * GB:
            trend.append({"label": "biggest drop", "since": ts, "delta": delta})
    return trend


def _baseline_changes(limit: int = 4) -> dict | None:
    """Top-level deltas between the two newest baselines of the most recently snapshotted root."""
    db = store.default_db_path()
    if not os.path.exists(db):
        return None
    try:
        conn = store.connect(db)
        latest = store.list_baselines(conn, limit=1)
        if not latest:
            return None
        root = latest[0]["root_path"]
        pair = store.list_baselines(conn, root, limit=2)
        if len(pair) < 2:
            return {"root": root, "taken_ts": pair[0]["taken_ts"], "changes": []}
        new, old = (json.loads(store.get_baseline(conn, row["id"])["entries_json"]) for row in pair)
    except Exception:
        return None
    changes = []
    for rel in set(new) | set(old):
        if rel == "." or os.sep in rel:
            continue
        delta = new.get(rel, {}).get("size", 0) - old.get(rel, {}).get("size", 0)
        if abs(delta) >= 100 << 20:
            changes.append({"path": os.path.join(root, rel), "delta": delta})
    changes.sort(key=lambda c: abs(c["delta"]), reverse=True)
    return {"root": root, "taken_ts": pair[0]["taken_ts"], "since_ts": pair[1]["taken_ts"],
            "total_delta": pair[0]["total_bytes"] - pair[1]["total_bytes"], "changes": changes[:limit]}


def _big_recent_files(limit: int = 5) -> list[dict]:
    """Large files modified in the last week. Spotlight on macOS; a time-boxed look elsewhere."""
    cutoff = time.time() - RECENT_DAYS * 86400
    paths: list[str] = []
    if sys.platform == "darwin":
        query = f"kMDItemFSSize > {BIG_FILE} && kMDItemFSContentChangeDate >= $time.today(-{RECENT_DAYS})"
        paths = [p for p in _run(["mdfind", "-onlyin", HOME, query]).splitlines() if p]
    else:
        deadline = time.time() + 1.0
        stack = [os.path.join(HOME, d) for d in ("Downloads", "Desktop", "Documents", "Videos")]
        while stack and time.time() < deadline:
            try:
                with os.scandir(stack.pop()) as it:
                    for entry in it:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            st = entry.stat(follow_symlinks=False)
                            if st.st_size >= BIG_FILE and st.st_mtime >= cutoff:
                                paths.append(entry.path)
            except OSError:
                continue

    files = []
    for path in paths:
        try:
            st = os.lstat(path)
        except OSError:
            continue
        # Spotlight also matches bundles (.app); only plain files have a meaningful st_size.
        if not os.path.isfile(path) or os.path.islink(path) or st.st_mtime < cutoff:
            continue
        size = getattr(st, "st_blocks", 0) * 512 or st.st_size
        if size >= BIG_FILE:
            files.append({"path": path, "bytes": size, "mtime": st.st_mtime})
    files.sort(key=lambda f: f["bytes"], reverse=True)
    return files[:limit]


# ---------------------------------------------------------------------------
# collect + print
# ---------------------------------------------------------------------------

def collect() -> dict:
    with ThreadPoolExecutor(max_workers=7) as pool:
        jobs = {
            "disk": pool.submit(_main_volume),
            "drives": pool.submit(_other_drives),
            "memory": pool.submit(_memory),
            "memory_users": pool.submit(_memory_users),
            "baselines": pool.submit(_baseline_changes),
            "big_files": pool.submit(_big_recent_files),
            "guard": pool.submit(maint.guard_status),
        }
        data = {}
        for key, job in jobs.items():
            try:
                data[key] = job.result()
            except Exception:
                data[key] = None

    readings = _load_readings()
    free = data["disk"]["free"] if data["disk"] else 0
    data["free_trend"] = _free_trend(free, readings) if free else []
    if free:
        _record_reading(free, readings)
    data["user"] = getpass.getuser()
    data["host"] = platform.node().split(".")[0]
    return data


def _os_label() -> str:
    if sys.platform == "darwin":
        return f"macOS {platform.mac_ver()[0]}"
    if sys.platform == "win32":
        # Windows 11 still reports version 10.0; older Pythons say "10". Build 22000+ is 11.
        return "Windows 11" if sys.getwindowsversion().build >= 22000 else f"Windows {platform.release()}"
    # "Debian GNU/Linux 12 (bookworm)", "Raspberry Pi OS", ... beats a bare kernel version.
    try:
        with open("/etc/os-release", encoding="utf-8") as f:
            info = dict(line.rstrip("\n").split("=", 1) for line in f if "=" in line)
        name = info.get("PRETTY_NAME", "").strip('"')
        if name:
            return name if platform.machine() == "x86_64" else f"{name} ({platform.machine()})"
    except OSError:
        pass
    return f"{platform.system()} {platform.release()}"


def _used_color(fraction: float) -> str:
    return r.RED if fraction >= 0.9 else r.YELLOW if fraction >= 0.75 else r.GREEN


def _volume_line(label: str, vol: dict, bar_width: int) -> str:
    frac = vol["used"] / vol["total"] if vol["total"] else 0
    free_color = r.RED if vol["free"] < CRITICAL_FREE else r.YELLOW if vol["free"] < WARN_FREE else ""
    return (f"  {r.BOLD}{label}{r.RESET}  {r.bar(frac, bar_width, _used_color(frac))} "
            f"{r.human_size(vol['used']):>9} of {r.human_size(vol['total']):<9}"
            f"{free_color}{r.human_size(vol['free']):>9} free{r.RESET}")


def _describe_cleaned(items: list[str], width: int) -> str:
    # Cache entries read "name (size)"; project junk is logged as a path.
    shown = [r.truncate_path(i, 40) if os.sep in i else i for i in items[:3]]
    more = f" +{len(items) - 3} more" if len(items) > 3 else ""
    return (", ".join(shown) + more)[: max(20, width)]


def _print_guard(guard: dict | None, name_width: int, indent: str, width: int) -> None:
    """Guard's state and what it did lately. Nothing is shown when it isn't installed."""
    if not guard or not guard["installed"]:
        return
    parts = []
    last = guard["last_run"]
    every = guard["every_hours"]
    if guard["loaded"] is False:
        parts.append(f"{r.YELLOW}installed but not loaded{r.RESET} {r.DIM}(di guard --install to reload){r.RESET}")
    elif guard["errored"]:
        parts.append(f"{r.RED}● last run failed{r.RESET} {r.DIM}(see guard.log){r.RESET}")
    elif last and every and time.time() - last["when"] > every * 3600 * 2 + 600:
        # launchd skips intervals while the Mac sleeps, so only flag a clear miss.
        parts.append(f"{r.YELLOW}● stalled{r.RESET} {r.DIM}(no check for {r.human_age(last['when'])[:-4]}){r.RESET}")
    else:
        parts.append(f"{r.GREEN}● active{r.RESET}")
    if every:
        parts.append(f"every {every:g}h")
    if guard["auto"]:
        where = " + " + ", ".join(r.truncate_path(d, 20) for d in guard["dev"]) if guard["dev"] else ""
        parts.append(f"auto-clean caches{where}")
    else:
        parts.append("notify only")
    if last:
        level_color = {"ok": r.GREEN, "low": r.YELLOW, "critical": r.RED}.get(last.get("level"), "")
        parts.append(f"last check {r.human_age(last['when'])}: "
                     f"{level_color}{last.get('level', '?')}{r.RESET}, {r.human_size(last['free'])} free")
    else:
        parts.append(f"{r.DIM}no checks yet{r.RESET}")
    print(f"  {r.BOLD}{'Guard':<{name_width}}{r.RESET}  " + f"{r.DIM} · {r.RESET}".join(parts))

    for e in guard["actions"]:
        what = []
        if e.get("cleaned"):
            what.append(f"cleaned {_describe_cleaned(e['cleaned'], width - len(indent) - 30)}")
            if e.get("recovered"):
                what.append(f"{r.GREEN}recovered {r.human_size(e['recovered'])}{r.RESET}")
        if e.get("ballast_released"):
            what.append(f"{r.YELLOW}released {r.human_size(e['ballast_released'])} ballast{r.RESET}")
        print(f"{indent}{r.DIM}{r.human_age(e['when']):>8}{r.RESET}  " + f"{r.DIM} · {r.RESET}".join(what))


def print_summary(data: dict | None = None) -> None:
    data = data or collect()
    width = min(r.term_width(), 100)
    bar_width = 20
    name_width = 16
    indent = " " * (2 + name_width + 2)

    print()
    print(r.header("Disk Intelligence",
                   f"{data['user']}@{data['host']} · {_os_label()} · {time.strftime('%Y-%m-%d %H:%M')}"))
    print(r.rule(width))

    disk = data.get("disk")
    if disk:
        print(_volume_line(f"{disk['name'][:name_width]:<{name_width}}", disk, bar_width))
        notes = []
        if disk["free"] < CRITICAL_FREE:
            notes.append(f"{r.RED}critically low — di caches, di clean ~/dev{r.RESET}")
        elif disk["free"] < WARN_FREE:
            notes.append(f"{r.YELLOW}running low — di caches, di reclaim ~{r.RESET}")
        if disk["ballast"]:
            notes.append(f"{r.human_size(disk['ballast'])} ballast held (di ballast release)")
        if notes:
            print(f"{indent}{f'{r.DIM} · {r.RESET}'.join(notes)}")

    for drive in data.get("drives") or []:
        print(_volume_line(f"{drive['name'][:name_width]:<{name_width}}", drive, bar_width)
              + f"  {r.DIM}{drive['type']}{r.RESET}")

    mem = data.get("memory")
    if mem and mem["total"]:
        frac = mem["used"] / mem["total"]
        line = (f"  {r.BOLD}{'Memory':<{name_width}}{r.RESET}  {r.bar(frac, bar_width, _used_color(frac))} "
                f"{r.human_size(mem['used']):>9} of {r.human_size(mem['total']):<9}")
        if mem["swap_used"]:
            color = r.YELLOW if mem["swap_used"] >= GB else r.DIM
            line += f"{color}{r.human_size(mem['swap_used']):>9} swap{r.RESET}"
            if mem["swap_used"] >= GB:
                line += f" {r.DIM}(on disk){r.RESET}"
        print(line)
        users = data.get("memory_users") or []
        if users:
            parts = [f"{u['name']} {r.DIM}{r.human_size(u['bytes'])}{r.RESET}" for u in users]
            print(f"{indent}{r.DIM}top:{r.RESET} " + f"{r.DIM} · {r.RESET}".join(parts))

    _print_guard(data.get("guard"), name_width, indent, width)

    print()
    print(f"  {r.BOLD}Recent changes{r.RESET}")
    shown = False
    trend = data.get("free_trend") or []
    if trend:
        parts = []
        for t in trend:
            # Free space going down means the disk filled up: show that as growth (red).
            used_delta = -t["delta"]
            label = t["label"] if t["label"] != "biggest drop" else f"biggest jump {r.human_age(t['since'])}"
            parts.append(f"{r.delta_color(used_delta)}{r.human_size(used_delta, signed=True)}{r.RESET} {label}")
        print(f"  {r.DIM}used space{r.RESET}  " + f"{r.DIM} · {r.RESET}".join(parts))
        shown = True

    base = data.get("baselines")
    if base and base["changes"]:
        print(f"  {r.DIM}baseline{r.RESET}    {r.truncate_path(base['root'], 30)} "
              f"{r.delta_color(base['total_delta'])}{r.human_size(base['total_delta'], signed=True)}{r.RESET}"
              f" {r.DIM}between {r.human_age(base['since_ts'])} and {r.human_age(base['taken_ts'])}{r.RESET}")
        for c in base["changes"]:
            print(f"              {r.delta_color(c['delta'])}{r.human_size(c['delta'], signed=True):>10}{r.RESET}"
                  f"  {r.truncate_path(c['path'], width - 28)}")
        shown = True

    files = data.get("big_files") or []
    if files:
        print(f"  {r.DIM}big files changed this week{r.RESET}")
        for f in files:
            print(f"              {r.human_size(f['bytes']):>10}  {r.DIM}{r.human_age(f['mtime']):>8}{r.RESET}"
                  f"  {r.truncate_path(f['path'], width - 36)}")
        shown = True

    if not shown:
        r.note("  nothing recorded yet")
    hints = []
    if not base:
        hints.append("di snapshot ~ to track growth")
    if not (data.get("guard") or {}).get("installed"):
        hints.append("di guard --install to watch free space")
    hints.append("di recent for a full look")
    r.note("  " + " · ".join(hints))

