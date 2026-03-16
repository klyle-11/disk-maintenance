"""
Disk Usage Scanner Module
==========================
Native implementation of du-hast-much functionality for disk-maintenance project.
Extracted core scanning functions from du-hast-much project.
"""

import os
import time
from pathlib import Path
from typing import Callable, Optional


def format_size(n_bytes: int) -> str:
    """Format byte count as human-readable string (GB, MB, KB, B)."""
    for unit, threshold in [("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10)]:
        if n_bytes >= threshold:
            return f"{n_bytes / threshold:.1f} {unit}"
    return f"{n_bytes} B"


def _walk_size(
    path: Path,
    on_progress: Optional[Callable],
    files_counter: list,
    latest_mtime: list,
    exclude_set: Optional[set] = None
) -> int:
    """Recursively sum file sizes under path. Returns total bytes."""
    exclude_set = exclude_set or set()
    total = 0
    try:
        for entry in os.scandir(path):
            if on_progress:
                on_progress({"current_dir": str(path), "files_scanned": files_counter[0]})
            if entry.is_symlink():
                stat = entry.stat(follow_symlinks=False)
                total += stat.st_size
                if stat.st_mtime > latest_mtime[0]:
                    latest_mtime[0] = stat.st_mtime
            elif entry.is_file(follow_symlinks=False):
                files_counter[0] += 1
                stat = entry.stat(follow_symlinks=False)
                total += stat.st_size
                if stat.st_mtime > latest_mtime[0]:
                    latest_mtime[0] = stat.st_mtime
            elif entry.is_dir(follow_symlinks=False):
                if entry.name not in exclude_set:
                    total += _walk_size(Path(entry.path), on_progress, files_counter, latest_mtime, exclude_set)
    except (PermissionError, FileNotFoundError):
        if on_progress:
            on_progress({"current_dir": str(path), "files_scanned": files_counter[0],
                         "warning": f"Cannot access: {path}"})
    return total


def scan_directory(
    path: str,
    depth: int = 1,
    on_progress: Optional[Callable] = None,
    exclude: Optional[list] = None,
    on_result: Optional[Callable] = None
) -> list[dict]:
    """
    Scan directory and return list of subdirectories with size info.

    Args:
        path: Directory path to scan
        depth: Scan depth (default: 1)
        on_progress: Callback for progress updates
        exclude: List of directory names to exclude
        on_result: Callback called when each directory scan completes

    Returns:
        List of dicts with keys: name, path, size, files, latest_mtime, avg_file_size
    """
    root = Path(path)
    exclude_set = set(exclude) if exclude else set()
    results = []
    try:
        entries = list(os.scandir(root))
    except PermissionError:
        return []

    for entry in entries:
        if not entry.is_dir(follow_symlinks=False):
            continue
        if entry.name in exclude_set:
            continue

        files_counter = [0]
        latest_mtime = [0.0]
        size = _walk_size(Path(entry.path), on_progress, files_counter, latest_mtime, exclude_set)
        avg_size = size / files_counter[0] if files_counter[0] > 0 else 0

        result = {
            "name": entry.name,
            "path": entry.path,
            "size": size,
            "files": files_counter[0],
            "latest_mtime": latest_mtime[0],
            "avg_file_size": avg_size,
        }
        results.append(result)

        if on_result:
            on_result(result)

    return results
