"""
Space-keeping tips, shared by the `di` CLI and the desktop app (/api/tips).

Each tip can declare when it is relevant (tool installed, folder present, disk
low). The CLI shows one relevant tip after a command now and then; the app
lists them all, relevant ones first.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
from dataclasses import asdict, dataclass

HOME = os.path.expanduser("~")
GB = 1 << 30
LOW_SPACE = 20 * GB

# How often the CLI volunteers a tip when the disk is healthy.
TIP_INTERVAL = 6 * 3600


@dataclass
class Tip:
    id: str
    title: str
    body: str
    command: str = ""
    # Shown when any condition holds: "always", "low", "darwin", "win32",
    # "linux", "tool:<name>", or "path:<p>" where p is home-relative or starts
    # with %LOCALAPPDATA% / %APPDATA%.
    when: tuple[str, ...] = ("always",)
    # Only ever shown on these platforms (empty = all).
    only: tuple[str, ...] = ()


TIPS: list[Tip] = [
    Tip("docker-disk",
        "Docker's disk image keeps what it grabs",
        "Docker.raw grows as images and volumes pile up. Pruning frees space inside the VM; "
        "Docker Desktop then hands it back to macOS. Lower Settings → Resources → Disk usage limit "
        "to cap how big it can get.",
        "docker system prune -a --volumes",
        ("tool:docker", "path:Library/Containers/com.docker.docker"), only=("darwin",)),
    Tip("wsl-vhdx",
        "WSL and Docker disks only ever grow",
        "WSL distros and Docker Desktop keep their files in .vhdx virtual disks that don't shrink when "
        "you delete things inside them. Prune Docker first, then make the disks sparse (WSL 2.0+) "
        "so freed space returns to Windows automatically.",
        "docker system prune -a --volumes; wsl --shutdown; wsl --manage <distro> --set-sparse true",
        ("tool:wsl", "tool:docker", "path:%LOCALAPPDATA%/Docker/wsl"), only=("win32",)),
    Tip("hiberfil",
        "hiberfil.sys can be many GB",
        "Hibernation reserves a file sized to a large share of your RAM on C:. If you never hibernate, "
        "turn it off (admin terminal). Fast Startup also uses it.",
        "powercfg /hibernate off",
        ("win32",), only=("win32",)),
    Tip("pagefile",
        "The page file lives on C:",
        "Windows grows pagefile.sys when memory runs short. Closing idle Electron apps and dev servers "
        "keeps it small; check its current size in Settings → System → About → Advanced system settings.",
        "Get-CimInstance Win32_PageFileUsage",
        ("win32",), only=("win32",)),
    Tip("restore-points",
        "System Restore can hold a lot of space",
        "Restore points and shadow copies are capped as a percentage of the drive. Check the cap and lower "
        "it under System Protection → Configure if it's large.",
        "vssadmin list shadowstorage",
        ("win32",), only=("win32",)),
    Tip("winsxs",
        "Old Windows Update components",
        "The component store (WinSxS) keeps superseded update files. Cleaning it is safe; run it from "
        "an admin terminal.",
        "Dism.exe /Online /Cleanup-Image /StartComponentCleanup",
        ("win32",), only=("win32",)),
    Tip("storage-sense",
        "Storage Sense is Windows' built-in guard",
        "Turn it on in Settings → System → Storage to empty the Recycle Bin, temp files and old "
        "Downloads on a schedule. It pairs well with di guard for developer caches.",
        "start ms-settings:storagepolicies",
        ("win32",), only=("win32",)),
    Tip("recycle-bin",
        "Deleted isn't freed until the Recycle Bin is empty",
        "Files in the Recycle Bin still count against your drive.",
        "Clear-RecycleBin -Force",
        ("win32",), only=("win32",)),
    Tip("apfs-snapshots",
        "\"System Data\" is often snapshots",
        "Time Machine and macOS updates leave local APFS snapshots that hold on to deleted files. "
        "Update snapshots clear after the update finishes and you restart; Time Machine ones can be thinned.",
        "tmutil listlocalsnapshots /",
        ("darwin",), only=("darwin",)),
    Tip("purgeable",
        "Finder's \"available\" counts space macOS hasn't freed yet",
        "Finder includes purgeable space (caches, snapshots) that macOS only frees under pressure. "
        "df shows what is actually free right now.",
        "df -h /System/Volumes/Data",
        ("darwin",), only=("darwin",)),
    Tip("swap",
        "Swap lives on your disk",
        "When memory runs short, macOS writes swap files to /private/var/vm, and they can reach several GB. "
        "Quitting idle Electron apps and dev servers keeps swap small; a restart clears it.",
        "sysctl vm.swapusage",
        ("darwin",), only=("darwin",)),
    Tip("headroom",
        "Leave 10–15% of the disk free",
        "APFS, swap and updates all need working room, and a nearly full SSD is slower. "
        "A ballast file holds a floor of space you can release in an emergency.",
        "di ballast set 5G",
        ("low",)),
    Tip("guard",
        "Let di watch the disk for you",
        "The guard runs every couple of hours: it notifies you when space runs low, cleans safe caches, "
        "and releases the ballast when things get critical.",
        "di guard --auto --dev ~/dev --install",
        ("always",)),
    Tip("dev-junk",
        "Old projects keep their node_modules forever",
        "Dependencies and build caches in projects you haven't touched in weeks are pure dead weight. "
        "Reinstalling takes one command when you come back.",
        "di clean ~/dev --older-than 14",
        ("path:dev",)),
    Tip("pkg-caches",
        "Package managers never clean up after themselves",
        "npm, yarn, bun, pip, cargo and editor updaters keep every download. They are safe to clear "
        "and refill as needed.",
        "di caches",
        ("always",)),
    Tip("brew",
        "Homebrew keeps old versions and downloads",
        "brew cleanup deletes old kegs and cached downloads; autoremove drops dependencies nothing uses.",
        "brew cleanup -s --prune=all && brew autoremove",
        ("tool:brew",), only=("darwin", "linux")),
    Tip("xcode",
        "Xcode and simulators are space hogs",
        "DerivedData, old device support files and simulator runtimes for unavailable devices "
        "can take tens of GB.",
        "xcrun simctl delete unavailable",
        ("path:Library/Developer",), only=("darwin",)),
    Tip("nvm",
        "Unused Node versions add up",
        "Each Node version under nvm is 50–100 MB, plus its global packages.",
        "nvm ls" if sys.platform != "win32" else "nvm list",
        ("path:.nvm", "path:%APPDATA%/nvm")),
    Tip("conda",
        "Conda keeps every package tarball",
        "conda clean removes cached tarballs and unused packages.",
        "conda clean -a",
        ("tool:conda",)),
    Tip("ios-backups",
        "Old iPhone backups",
        "Device backups live in MobileSync and can be many GB each. Manage them in Finder "
        "(select the device → Manage Backups), or in iTunes / Apple Devices on Windows.",
        "du -sh ~/Library/Application\\ Support/MobileSync/Backup" if sys.platform != "win32"
        else "explorer %APPDATA%\\Apple Computer\\MobileSync\\Backup",
        ("path:Library/Application Support/MobileSync/Backup", "path:%APPDATA%/Apple Computer/MobileSync/Backup",
         "path:Apple/MobileSync/Backup")),
    Tip("messages",
        "Messages attachments",
        "Photos and videos from Messages pile up in ~/Library/Messages. System Settings → General → "
        "Storage → Messages lets you review and remove large attachments.",
        "du -sh ~/Library/Messages/Attachments",
        ("path:Library/Messages/Attachments",), only=("darwin",)),
    Tip("trash",
        "Deleted isn't freed until the Trash is empty",
        "Anything in the Trash still counts against your disk.",
        "du -sh ~/.Trash" if sys.platform == "darwin" else "du -sh ~/.local/share/Trash",
        ("path:.Trash", "path:.local/share/Trash"), only=("darwin", "linux")),
    Tip("apt-cache",
        "apt keeps every package it downloads",
        "Downloaded .deb files stay in /var/cache/apt/archives after install. autoremove also drops "
        "old kernels and dependencies nothing needs any more.",
        "sudo apt clean && sudo apt autoremove --purge",
        ("tool:apt",), only=("linux",)),
    Tip("journald",
        "The system journal grows to its cap",
        "journald keeps logs until they hit a size limit that can be several GB, which hurts on a small "
        "SD card. Vacuum it now; set SystemMaxUse= in /etc/systemd/journald.conf to keep it down.",
        "sudo journalctl --vacuum-size=200M",
        ("tool:journalctl",), only=("linux",)),
    Tip("docker-linux",
        "Docker images and volumes pile up",
        "Old images, stopped containers and dangling volumes live under /var/lib/docker.",
        "docker system df && docker system prune -a --volumes",
        ("tool:docker",), only=("linux",)),
]


def free_bytes() -> int:
    try:
        return shutil.disk_usage(HOME).free
    except OSError:
        return 0


def _path(p: str) -> str | None:
    if p.startswith("%"):
        var, _, rest = p[1:].partition("%")
        base = os.environ.get(var)
        return os.path.join(base, *rest.strip("/").split("/")) if base else None
    return os.path.join(HOME, *p.split("/"))


def _condition(cond: str, free: int) -> bool:
    if cond == "always":
        return True
    if cond == "low":
        return free < LOW_SPACE
    if cond in ("darwin", "win32", "linux"):
        return sys.platform.startswith(cond)
    if cond.startswith("path:"):
        full = _path(cond[5:])
        return bool(full) and os.path.exists(full)
    if cond.startswith("tool:"):
        return shutil.which(cond[5:]) is not None
    return False


def applies_here(tip: Tip) -> bool:
    return not tip.only or any(sys.platform.startswith(p) for p in tip.only)


def is_relevant(tip: Tip, free: int) -> bool:
    return applies_here(tip) and any(_condition(c, free) for c in tip.when)


def tips_payload() -> dict:
    """Everything the app needs: free space and tips, relevant ones first."""
    free = free_bytes()
    # Tips for another OS are left out entirely, not just marked irrelevant.
    rows = [{**asdict(t), "relevant": is_relevant(t, free)} for t in TIPS if applies_here(t)]
    rows.sort(key=lambda t: not t["relevant"])
    for row in rows:
        row.pop("when")
        row.pop("only")
    return {"free_bytes": free, "low_space": free < LOW_SPACE, "tips": rows}


# ---------------------------------------------------------------------------
# CLI: an occasional tip after a command
# ---------------------------------------------------------------------------

def _state_path() -> str:
    from . import store  # noqa: PLC0415 — keep the app import light
    return os.path.join(os.path.dirname(store.default_db_path()), "tips.json")


def _load_state() -> dict:
    try:
        with open(_state_path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def pick_tip(force: bool = False) -> Tip | None:
    """
    Choose a tip to show, or None if it isn't time yet. Shows at most one per
    TIP_INTERVAL while the disk is healthy, and every time when it is low.
    Rotates through relevant tips, least recently shown first.
    """
    if os.environ.get("DI_TIPS", "1") == "0":
        return None
    state = _load_state()
    shown: dict = state.get("shown", {})
    free = free_bytes()
    now = time.time()
    if not force and free >= LOW_SPACE and now - state.get("last", 0) < TIP_INTERVAL:
        return None

    candidates = [t for t in TIPS if is_relevant(t, free)]
    if not candidates:
        return None
    tip = min(candidates, key=lambda t: shown.get(t.id, 0))
    shown[tip.id] = now
    try:
        with open(_state_path(), "w") as f:
            json.dump({"last": now, "shown": shown}, f)
    except OSError:
        pass
    return tip


def format_tip(tip: Tip, r) -> str:
    """Render a tip as a small framed note. `r` is the render module."""
    width = min(r.term_width(), 100) - 4
    words, lines, line = tip.body.split(), [], ""
    for w in words:
        if len(line) + len(w) + 1 > width - 2:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    if line:
        lines.append(line)
    out = [f"  {r.YELLOW}tip{r.RESET} {r.BOLD}{tip.title}{r.RESET}"]
    out += [f"  {r.DIM}│{r.RESET} {r.DIM}{l}{r.RESET}" for l in lines]
    if tip.command:
        out.append(f"  {r.DIM}│{r.RESET} {r.CYAN}$ {tip.command}{r.RESET}")
    return "\n".join(out)
