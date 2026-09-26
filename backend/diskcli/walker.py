"""
Fast, dependency-free directory walker for Disk Intelligence.

Produces per-directory aggregates in a single pass:
    - total bytes (apparent size, hardlinks counted once)
    - file count
    - newest mtime seen anywhere beneath the directory
    - "recent bytes": bytes held by files modified within a cutoff window

Only the standard library is used so the CLI starts instantly and works
without the FastAPI/uvicorn stack the GUI backend needs.
"""

from __future__ import annotations

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


def _walk_subtree(
    root: str,
    base_depth: int,
    max_depth: int,
    excludes: set[str],
    recent_cutoff: float,
    seen_inodes: set,
    nodes: dict[str, DirNode],
    stop: list,
) -> DirNode:
    """
    Recursively walk `root`, filling `nodes` for every directory down to
    `max_depth`. Below max_depth the sizes are still summed, they are just
    folded into the deepest recorded ancestor instead of getting their own row.

    Returns the node for `root`.
    """
    node = DirNode(path=root, depth=base_depth)
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
                if entry.name in excludes or _should_prune(entry.path):
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
                )
                node.size += child.size
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
                node.size += st.st_size
                node.files += 1
                node.own_size += st.st_size
                node.own_files += 1
                if st.st_mtime > node.newest_mtime:
                    node.newest_mtime = st.st_mtime
                if st.st_mtime >= recent_cutoff:
                    node.recent_bytes += st.st_size
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
) -> ScanResult:
    """
    Scan `root` and return aggregates for every directory down to `max_depth`.

    The top level is fanned out across a thread pool: os.scandir and stat both
    release the GIL, so this is a real speedup on SSDs without any of the
    complexity of multiprocessing.
    """
    root = os.path.abspath(os.path.expanduser(root))
    excludes = set(excludes) if excludes is not None else set(DEFAULT_EXCLUDES)
    recent_cutoff = time.time() - recent_days * 86400
    started = time.time()

    nodes: dict[str, DirNode] = {}
    root_node = DirNode(path=root, depth=0)
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
                if entry.name in excludes or _should_prune(entry.path):
                    continue
                top_dirs.append(entry.path)
            else:
                st = entry.stat(follow_symlinks=False)
                root_node.size += st.st_size
                root_node.files += 1
                root_node.own_size += st.st_size
                root_node.own_files += 1
                if st.st_mtime > root_node.newest_mtime:
                    root_node.newest_mtime = st.st_mtime
                if st.st_mtime >= recent_cutoff:
                    root_node.recent_bytes += st.st_size
                    root_node.recent_files += 1
        except OSError:
            root_node.errors += 1

    done = [0]

    def run(path: str) -> DirNode:
        sub_nodes: dict[str, DirNode] = {}
        node = _walk_subtree(
            path, 1, max_depth, excludes, recent_cutoff, set(), sub_nodes, []
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
                    if entry.name in excludes or _should_prune(entry.path):
                        continue
                    stack.append(entry.path)
                else:
                    st = entry.stat(follow_symlinks=False)
                    if st.st_mtime >= cutoff and st.st_size >= min_size:
                        hits.append(
                            {
                                "path": entry.path,
                                "size": st.st_size,
                                "mtime": st.st_mtime,
                            }
                        )
            except OSError:
                continue

    hits.sort(key=lambda h: h["size"], reverse=True)
    return hits[:limit]
