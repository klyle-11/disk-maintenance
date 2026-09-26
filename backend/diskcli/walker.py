"""
Fast, dependency-free directory walker for Disk Intelligence.

Produces per-directory aggregates in a single pass:
    - total bytes (apparent size, hardlinks counted once, cloud-only files as 0)
    - file count
    - newest mtime seen anywhere beneath the directory
    - "recent bytes": bytes held by files modified within a cutoff window
    - "cloud bytes": downloaded files inside a OneDrive/Dropbox/iCloud/... sync
      folder, which the provider can free without losing them

Only the standard library is used so the CLI starts instantly and works
without the FastAPI/uvicorn stack the GUI backend needs.
"""

from __future__ import annotations

import functools
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

# Directory names skipped by default. These are either volatile OS state,
# not really "yours", or virtual filesystems that would make a scan crawl.
DEFAULT_EXCLUDES = {
    ".Trashes",
    ".fseventsd",
    ".Spotlight-V100",
    ".DocumentRevisions-V100",
    ".TemporaryItems",
    "$Recycle.Bin",
    "System Volume Information",
}

# Absolute prefixes that are never worth walking.
DEFAULT_PRUNE_PREFIXES = (
    "/System/Volumes",
    "/private/var/vm",
    "/dev",
    "/proc",
    "/sys",
    "/Volumes/com.apple.TimeMachine",
)


@dataclass
class DirNode:
    """Aggregated stats for one directory subtree."""

    path: str
    depth: int
    size: int = 0
    files: int = 0
    newest_mtime: float = 0.0
    recent_bytes: int = 0
    recent_files: int = 0
    errors: int = 0
    # Bytes/files sitting directly in this directory rather than in a subdir.
    # Disjoint from every child subtree, so loose files can be attributed.
    own_size: int = 0
    own_files: int = 0
    children: list[str] = field(default_factory=list)
    # Cloud provider whose sync folder holds this directory, if any.
    cloud: str | None = None
    cloud_bytes: int = 0


@dataclass
class ScanResult:
    root: str
    nodes: dict[str, DirNode]
    total_size: int
    total_files: int
    elapsed: float
    errors: int
    recent_cutoff: float

    def node(self, path: str) -> DirNode | None:
        return self.nodes.get(path)

    def children_of(self, path: str) -> list[DirNode]:
        parent = self.nodes.get(path)
        if not parent:
            return []
        return [self.nodes[c] for c in parent.children if c in self.nodes]

    def at_depth(self, depth: int) -> list[DirNode]:
        return [n for n in self.nodes.values() if n.depth == depth]


def _should_prune(path: str) -> bool:
    return any(path.startswith(p) for p in DEFAULT_PRUNE_PREFIXES)


_WIN = sys.platform == "win32"
_ATTR_REPARSE_POINT = 0x400
_ATTR_OFFLINE = 0x1000
_ATTR_RECALL_ON_DATA_ACCESS = 0x400000
_NAME_SURROGATE = 0x20000000  # reparse tag bit: junctions and symlinks, not cloud placeholders


def is_link(entry: os.DirEntry) -> bool:
    """
    Symlink, or on Windows a directory junction. Python only reports the
    former, and walking into junctions (pnpm's node_modules is full of them)
    counts the same bytes twice.
    """
    if entry.is_symlink():
        return True
    if not _WIN:
        return False
    st = entry.stat(follow_symlinks=False)
    return bool(st.st_file_attributes & _ATTR_REPARSE_POINT
                and getattr(st, "st_reparse_tag", 0) & _NAME_SURROGATE)


def is_link_path(path: str) -> bool:
    """is_link for a path string (os.walk hands out names, not DirEntry objects)."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if os.path.islink(path):
        return True
    return bool(_WIN and st.st_file_attributes & _ATTR_REPARSE_POINT
                and getattr(st, "st_reparse_tag", 0) & _NAME_SURROGATE)


@functools.lru_cache(maxsize=1)
def cloud_roots() -> tuple[tuple[str, str], ...]:
    """
    (provider, folder) for every cloud sync folder on this machine. Windows
    registers them with the Cloud Files API (OneDrive, Dropbox, iCloud, Box...);
    macOS keeps them under ~/Library/CloudStorage and ~/Library/Mobile Documents.
    Downloaded files there look like ordinary files, so location is the tell.
    """
    found: dict[str, str] = {}
    home = os.path.expanduser("~")
    if _WIN:
        try:
            import winreg  # noqa: PLC0415

            base = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager"
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base) as key:
                for i in range(winreg.QueryInfoKey(key)[0]):
                    name = winreg.EnumKey(key, i)
                    try:
                        with winreg.OpenKey(key, name + r"\UserSyncRoots") as roots:
                            for j in range(winreg.QueryInfoKey(roots)[1]):
                                path = winreg.EnumValue(roots, j)[1]
                                if isinstance(path, str) and os.path.isdir(path):
                                    found[os.path.normcase(os.path.abspath(path))] = name.split("!")[0]
                    except OSError:
                        continue
        except OSError:
            pass
        for var in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
            path = os.environ.get(var)
            if path and os.path.isdir(path):
                found.setdefault(os.path.normcase(os.path.abspath(path)), "OneDrive")
    elif sys.platform == "darwin":
        try:
            for entry in os.scandir(os.path.join(home, "Library", "CloudStorage")):
                if entry.is_dir(follow_symlinks=False):
                    found[entry.path] = entry.name.split("-")[0]
        except OSError:
            pass
        icloud = os.path.join(home, "Library", "Mobile Documents")
        if os.path.isdir(icloud):
            found[icloud] = "iCloud Drive"
    return tuple(sorted(((p, f) for f, p in found.items()), key=lambda pf: pf[1]))


def cloud_provider(path: str) -> str | None:
    """The provider whose sync folder contains `path` (or is `path`)."""
    path = os.path.normcase(os.path.abspath(path))
    for provider, folder in cloud_roots():
        if path == folder or path.startswith(folder.rstrip(os.sep) + os.sep):
            return provider
    return None


def cloud_hint(provider: str) -> str:
    """How to free a provider's downloaded files without losing them."""
    if sys.platform == "darwin":
        return "Finder → right-click the folder → Remove Download"
    if provider == "OneDrive":
        return "right-click the folder → Free up space  (or: attrib +U -P /s /d \"<folder>\")"
    return f"right-click the folder → Free up space / Make online-only in {provider}"


def local_size(st: os.stat_result) -> int:
    """Bytes a file holds on this disk: 0 for OneDrive/iCloud files that live only in the cloud."""
    if _WIN and st.st_file_attributes & (_ATTR_OFFLINE | _ATTR_RECALL_ON_DATA_ACCESS):
        return 0
    return st.st_size


def _walk_subtree(
    root: str,
    base_depth: int,
    max_depth: int,
    excludes: set[str],
    recent_cutoff: float,
    seen_inodes: set,
    nodes: dict[str, DirNode],
    stop: list,
    cloud: str | None = None,
    on_file=None,
) -> DirNode:
    """
    Recursively walk `root`, filling `nodes` for every directory down to
    `max_depth`. Below max_depth the sizes are still summed, they are just
    folded into the deepest recorded ancestor instead of getting their own row.

    Returns the node for `root`.
    """
    node = DirNode(path=root, depth=base_depth, cloud=cloud or cloud_provider(root))
    if base_depth <= max_depth:
        nodes[root] = node

    try:
        entries = list(os.scandir(root))
    except (PermissionError, FileNotFoundError, NotADirectoryError, OSError):
        node.errors += 1
        return node

    for entry in entries:
        if stop and stop[0]:
            break
        try:
            if entry.is_dir(follow_symlinks=False):
                if entry.name in excludes or _should_prune(entry.path) or is_link(entry):
                    continue
                child = _walk_subtree(
                    entry.path,
                    base_depth + 1,
                    max_depth,
                    excludes,
                    recent_cutoff,
                    seen_inodes,
                    nodes,
                    stop,
                    node.cloud,
                    on_file,
                )
                node.size += child.size
                node.cloud_bytes += child.cloud_bytes
                node.files += child.files
                node.recent_bytes += child.recent_bytes
                node.recent_files += child.recent_files
                node.errors += child.errors
                if child.newest_mtime > node.newest_mtime:
                    node.newest_mtime = child.newest_mtime
                if child.path in nodes:
                    node.children.append(child.path)
            else:
                st = entry.stat(follow_symlinks=False)
                # Count a hardlinked file's bytes only once per scan.
                if st.st_nlink > 1:
                    key = (st.st_dev, st.st_ino)
                    if key in seen_inodes:
                        node.files += 1
                        continue
                    seen_inodes.add(key)
                size = local_size(st)
                node.size += size
                node.files += 1
                node.own_size += size
                node.own_files += 1
                if node.cloud:
                    node.cloud_bytes += size
                if on_file:
                    on_file(entry.path, size, st.st_mtime)
                if st.st_mtime > node.newest_mtime:
                    node.newest_mtime = st.st_mtime
                if st.st_mtime >= recent_cutoff:
                    node.recent_bytes += size
                    node.recent_files += 1
        except (PermissionError, FileNotFoundError, OSError):
            node.errors += 1
            continue

    return node


def scan(
    root: str,
    max_depth: int = 2,
    recent_days: float = 30.0,
    excludes: set[str] | None = None,
    workers: int = 8,
    on_progress=None,
    on_file=None,
) -> ScanResult:
    """
    Scan `root` and return aggregates for every directory down to `max_depth`.

    The top level is fanned out across a thread pool: os.scandir and stat both
    release the GIL, so this is a real speedup on SSDs without any of the
    complexity of multiprocessing.

    `on_file(path, local_bytes, mtime)` is called for every file (hardlinks
    once), from worker threads.
    """
    root = os.path.abspath(os.path.expanduser(root))
    excludes = set(excludes) if excludes is not None else set(DEFAULT_EXCLUDES)
    recent_cutoff = time.time() - recent_days * 86400
    started = time.time()

    nodes: dict[str, DirNode] = {}
    root_node = DirNode(path=root, depth=0, cloud=cloud_provider(root))
    nodes[root] = root_node

    try:
        top_entries = list(os.scandir(root))
    except (PermissionError, FileNotFoundError, NotADirectoryError) as exc:
        raise ScanError(f"Cannot read {root}: {exc}") from exc

    top_dirs = []
    # Hardlink dedup is per-thread to avoid locking; a file hardlinked across
    # two different top-level folders is rare enough that the small
    # over-count is a better trade than serialising every stat.
    for entry in top_entries:
        try:
            if entry.is_dir(follow_symlinks=False):
                if entry.name in excludes or _should_prune(entry.path) or is_link(entry):
                    continue
                top_dirs.append(entry.path)
            else:
                st = entry.stat(follow_symlinks=False)
                size = local_size(st)
                root_node.size += size
                root_node.files += 1
                root_node.own_size += size
                root_node.own_files += 1
                if root_node.cloud:
                    root_node.cloud_bytes += size
                if on_file:
                    on_file(entry.path, size, st.st_mtime)
                if st.st_mtime > root_node.newest_mtime:
                    root_node.newest_mtime = st.st_mtime
                if st.st_mtime >= recent_cutoff:
                    root_node.recent_bytes += size
                    root_node.recent_files += 1
        except OSError:
            root_node.errors += 1

    done = [0]

    def run(path: str) -> DirNode:
        sub_nodes: dict[str, DirNode] = {}
        node = _walk_subtree(
            path, 1, max_depth, excludes, recent_cutoff, set(), sub_nodes, [], root_node.cloud, on_file
        )
        nodes.update(sub_nodes)
        done[0] += 1
        if on_progress:
            on_progress(done[0], len(top_dirs), path)
        return node

    if top_dirs:
        with ThreadPoolExecutor(max_workers=max(1, min(workers, len(top_dirs)))) as pool:
            for node in pool.map(run, top_dirs):
                root_node.size += node.size
                root_node.cloud_bytes += node.cloud_bytes
                root_node.files += node.files
                root_node.recent_bytes += node.recent_bytes
                root_node.recent_files += node.recent_files
                root_node.errors += node.errors
                if node.newest_mtime > root_node.newest_mtime:
                    root_node.newest_mtime = node.newest_mtime
                if node.path in nodes:
                    root_node.children.append(node.path)

    return ScanResult(
        root=root,
        nodes=nodes,
        total_size=root_node.size,
        total_files=root_node.files,
        elapsed=time.time() - started,
        errors=root_node.errors,
        recent_cutoff=recent_cutoff,
    )


class ScanError(Exception):
    """Raised when a scan root cannot be read at all."""


def find_recent_files(
    root: str,
    recent_days: float = 30.0,
    limit: int = 40,
    min_size: int = 1024 * 1024,
    excludes: set[str] | None = None,
) -> list[dict]:
    """
    Return the largest individual files modified within the window, newest
    and biggest first. This is the "what actually landed on my disk lately"
    view, as opposed to the folder rollups.
    """
    root = os.path.abspath(os.path.expanduser(root))
    excludes = set(excludes) if excludes is not None else set(DEFAULT_EXCLUDES)
    cutoff = time.time() - recent_days * 86400
    hits: list[dict] = []

    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except (PermissionError, FileNotFoundError, OSError):
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    if entry.name in excludes or _should_prune(entry.path) or is_link(entry):
                        continue
                    stack.append(entry.path)
                else:
                    st = entry.stat(follow_symlinks=False)
                    size = local_size(st)
                    if st.st_mtime >= cutoff and size >= min_size:
                        hits.append(
                            {
                                "path": entry.path,
                                "size": size,
                                "mtime": st.st_mtime,
                            }
                        )
            except OSError:
                continue

    hits.sort(key=lambda h: h["size"], reverse=True)
    return hits[:limit]
