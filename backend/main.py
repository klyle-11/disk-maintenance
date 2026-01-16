"""
Disk Intelligence Tool - Python Backend
========================================
A FastAPI-based backend for disk scanning, analysis, and file management.

To run:
    1. Install dependencies: pip install fastapi uvicorn pydantic
    2. Run server: uvicorn main:app --reload --port 8000
"""

from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from sqlalchemy.orm import Session
import os
import uuid
import logging
import asyncio
import json
import time
from collections import defaultdict
from pathlib import Path

from database import get_db, SnapshotDB, serialize_snapshot, deserialize_snapshot

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def sanitize_string(s: str) -> str:
    """Remove or replace surrogate characters that can't be encoded to UTF-8."""
    if not s:
        return s
    # Encode to UTF-8, replacing surrogates with replacement character, then decode back
    return s.encode('utf-8', errors='surrogatepass').decode('utf-8', errors='replace')

app = FastAPI(title="Disk Intelligence API", version="1.0.0")

# Enable CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================================
# PYDANTIC MODELS
# ============================================================================

class ScanRequest(BaseModel):
    root_path: str

class ScanResponse(BaseModel):
    scan_id: str
    root_path: str
    started_at: str
    completed_at: str
    total_files: int
    total_folders: int
    total_size_bytes: int

class Finding(BaseModel):
    id: str
    category: str
    reason: str
    paths: list[str]
    total_bytes: int

class ExtensionSummary(BaseModel):
    extension: str
    file_count: int
    total_bytes: int

class ProgressEvent(BaseModel):
    scan_id: str
    event_type: str  # "progress" | "complete" | "error"
    files_scanned: int
    folders_scanned: int
    bytes_scanned: int
    current_path: str
    progress_percent: int
    elapsed_seconds: float
    message: str

class SnapshotRequest(BaseModel):
    scan_id: str
    root_path: str

class SnapshotResponse(BaseModel):
    id: str
    scan_id: str
    root_path: str
    findings: list[Finding]
    extensions: list[ExtensionSummary]
    scan_info: ScanResponse
    saved_at: str
    total_files: int
    total_folders: int
    total_size_bytes: int

class ComparisonItem(BaseModel):
    """A single item in the comparison tree."""
    name: str
    relative_path: str
    item_type: str  # "file" or "folder"
    status: str  # "identical", "modified", "missing_from_target", "extra_in_target"
    source_size: Optional[int] = None
    target_size: Optional[int] = None
    source_modified: Optional[str] = None
    target_modified: Optional[str] = None
    source_hash: Optional[str] = None
    target_hash: Optional[str] = None
    children: Optional[list["ComparisonItem"]] = None
    difference_count: int = 0  # For folders: count of differences within

class ComparisonRequest(BaseModel):
    source_path: str
    target_path: str
    deep_scan: bool = False

class ComparisonSummary(BaseModel):
    identical: int = 0
    modified: int = 0
    missing_from_target: int = 0
    extra_in_target: int = 0
    total_source_size: int = 0
    total_target_size: int = 0

class ComparisonResponse(BaseModel):
    comparison_id: str
    source_path: str
    target_path: str
    summary: ComparisonSummary
    tree: list[ComparisonItem]
    deep_scan: bool
    completed_at: str

# ============================================================================
# IN-MEMORY STORAGE (per scan)
# ============================================================================

class ScanData:
    def __init__(self):
        self.files: list[dict] = []
        self.folders: dict[str, dict] = {}  # path -> folder info
        self.scan_info: Optional[ScanResponse] = None

scans: dict[str, ScanData] = {}

# ============================================================================
# IGNORE LIST (hard-coded for MVP)
# ============================================================================

IGNORE_PATHS = [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
    "$Recycle.Bin",
    "System Volume Information",
]

CACHE_FOLDER_PATTERNS = [
    "node_modules",
    ".cache",
    "__pycache__",
    "dist",
    "build",
    "out",
    "tmp",
    "temp",
    ".tmp",
    ".temp",
    "cache",
    "Cache",
    ".git",
    ".venv",
    "venv",
    "env",
    ".env",
    ".next",
    ".nuxt",
    "target",  # Rust
    "bin",
    "obj",  # .NET
]

# ============================================================================
# DISK SCANNER
# ============================================================================

class DiskScanner:
    """
    Recursively scans a directory and collects file/folder metadata.
    """

    def __init__(self, root_path: str, progress_callback=None):
        self.root_path = root_path
        self.files: list[dict] = []
        self.folders: dict[str, dict] = {}
        self.progress_callback = progress_callback
        self.start_time = None

    def should_ignore(self, path: str) -> bool:
        """Check if path should be ignored."""
        path_lower = path.lower()
        for ignore in IGNORE_PATHS:
            if ignore.lower() in path_lower:
                return True
        return False

    def scan(self) -> tuple[list[dict], dict[str, dict]]:
        """
        Scan the root path and return (files, folders).
        """
        logger.info(f"Starting scan of: {self.root_path}")

        # Initialize folder for root
        self.folders[self.root_path] = {
            "path": self.root_path,
            "total_size": 0,
            "file_count": 0,
            "last_modified": None,
            "last_accessed": None,
        }

        try:
            for root, dirs, files in os.walk(self.root_path, topdown=True):
                # Filter out ignored directories
                dirs[:] = [d for d in dirs if not self.should_ignore(os.path.join(root, d))]

                # Initialize folder entry
                if root not in self.folders:
                    self.folders[root] = {
                        "path": root,
                        "total_size": 0,
                        "file_count": 0,
                        "last_modified": None,
                        "last_accessed": None,
                    }

                for filename in files:
                    try:
                        file_path = os.path.join(root, filename)
                        stat = os.stat(file_path)

                        file_info = {
                            "path": file_path,
                            "size_bytes": stat.st_size,
                            "extension": os.path.splitext(filename)[1].lower(),
                            "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                            "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                            "accessed_at": datetime.fromtimestamp(stat.st_atime).isoformat(),
                            "parent_dir": root,
                        }
                        self.files.append(file_info)

                        # Update folder stats
                        self._update_folder_stats(root, stat)

                    except (PermissionError, OSError) as e:
                        logger.debug(f"Skipping file {filename}: {e}")
                        continue

        except PermissionError as e:
            logger.warning(f"Permission denied for {self.root_path}: {e}")

        # Propagate folder sizes up the tree
        self._propagate_folder_sizes()

        logger.info(f"Scan complete: {len(self.files)} files, {len(self.folders)} folders")
        return self.files, self.folders

    async def scan_async(self) -> tuple[list[dict], dict[str, dict]]:
        """Async scan with progress callbacks."""
        self.start_time = time.time()
        logger.info(f"Starting async scan of: {self.root_path}")

        self.folders[self.root_path] = {
            "path": self.root_path,
            "total_size": 0,
            "file_count": 0,
            "last_modified": None,
            "last_accessed": None,
        }

        file_count = 0
        last_emit = time.time()
        total_bytes = 0

        try:
            for root, dirs, files in os.walk(self.root_path, topdown=True):
                dirs[:] = [d for d in dirs if not self.should_ignore(os.path.join(root, d))]

                if root not in self.folders:
                    self.folders[root] = {
                        "path": root,
                        "total_size": 0,
                        "file_count": 0,
                        "last_modified": None,
                        "last_accessed": None,
                    }

                for filename in files:
                    try:
                        file_path = os.path.join(root, filename)
                        stat = os.stat(file_path)

                        file_info = {
                            "path": file_path,
                            "size_bytes": stat.st_size,
                            "extension": os.path.splitext(filename)[1].lower(),
                            "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                            "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                            "accessed_at": datetime.fromtimestamp(stat.st_atime).isoformat(),
                            "parent_dir": root,
                        }
                        self.files.append(file_info)
                        self._update_folder_stats(root, stat)

                        file_count += 1
                        total_bytes += stat.st_size

                    except (PermissionError, OSError) as e:
                        logger.debug(f"Skipping file {filename}: {e}")
                        continue

                # Emit progress every 50 files or every 1 second
                now = time.time()
                if file_count % 50 == 0 or (now - last_emit) >= 1.0:
                    if self.progress_callback:
                        elapsed = now - self.start_time
                        depth = root.count(os.sep) - self.root_path.count(os.sep)
                        progress = min(95, int(20 + (depth * 5)))

                        await self.progress_callback({
                            "files_scanned": len(self.files),
                            "folders_scanned": len(self.folders),
                            "bytes_scanned": total_bytes,
                            "current_path": root,
                            "progress_percent": progress,
                            "elapsed_seconds": elapsed,
                            "message": f"Scanning: {root}"
                        })
                        last_emit = now
                        await asyncio.sleep(0)  # Yield control

        except PermissionError as e:
            logger.warning(f"Permission denied for {self.root_path}: {e}")

        self._propagate_folder_sizes()
        logger.info(f"Async scan complete: {len(self.files)} files, {len(self.folders)} folders")
        return self.files, self.folders

    def _update_folder_stats(self, folder_path: str, stat):
        """Update folder statistics with file info."""
        folder = self.folders[folder_path]
        folder["total_size"] += stat.st_size
        folder["file_count"] += 1

        mtime = datetime.fromtimestamp(stat.st_mtime)
        atime = datetime.fromtimestamp(stat.st_atime)

        if folder["last_modified"] is None or mtime > datetime.fromisoformat(folder["last_modified"]):
            folder["last_modified"] = mtime.isoformat()
        if folder["last_accessed"] is None or atime > datetime.fromisoformat(folder["last_accessed"]):
            folder["last_accessed"] = atime.isoformat()

    def _propagate_folder_sizes(self):
        """Propagate sizes from child folders to parents."""
        # Sort folders by depth (deepest first)
        sorted_folders = sorted(
            self.folders.keys(),
            key=lambda p: p.count(os.sep),
            reverse=True
        )

        for folder_path in sorted_folders:
            parent = os.path.dirname(folder_path)
            if parent in self.folders and parent != folder_path:
                self.folders[parent]["total_size"] += self.folders[folder_path]["total_size"]
                self.folders[parent]["file_count"] += self.folders[folder_path]["file_count"]

                # Update last modified/accessed
                child = self.folders[folder_path]
                par = self.folders[parent]

                if child["last_modified"] and (
                    par["last_modified"] is None or
                    child["last_modified"] > par["last_modified"]
                ):
                    par["last_modified"] = child["last_modified"]

                if child["last_accessed"] and (
                    par["last_accessed"] is None or
                    child["last_accessed"] > par["last_accessed"]
                ):
                    par["last_accessed"] = child["last_accessed"]

# ============================================================================
# ANALYZER
# ============================================================================

class Analyzer:
    """
    Analyzes scan data and produces findings.
    """

    # Thresholds
    LARGE_FOLDER_THRESHOLD = 1 * 1024 * 1024 * 1024  # 1 GB
    OLD_DAYS_THRESHOLD = 365  # 1 year
    RECENT_DAYS_THRESHOLD = 7
    TOP_N_LARGE = 20

    def __init__(self, files: list[dict], folders: dict[str, dict]):
        self.files = files
        self.folders = folders
        self.findings: list[Finding] = []
        self.finding_id = 0

    def _next_id(self) -> str:
        self.finding_id += 1
        return f"finding-{self.finding_id}"

    def analyze(self) -> list[Finding]:
        """Run all analysis heuristics and return findings."""
        logger.info("Starting analysis...")

        self._analyze_large_folders()
        self._analyze_old_large_folders()
        self._analyze_cache_candidates()
        self._analyze_duplicate_folder_candidates()
        self._analyze_duplicate_file_candidates()
        self._analyze_cold_archive_candidates()

        logger.info(f"Analysis complete: {len(self.findings)} findings")
        return self.findings

    def _analyze_large_folders(self):
        """Find top N largest folders."""
        large_folders = [
            (path, info) for path, info in self.folders.items()
            if info["total_size"] >= self.LARGE_FOLDER_THRESHOLD
        ]

        # Sort by size descending
        large_folders.sort(key=lambda x: x[1]["total_size"], reverse=True)

        for path, info in large_folders[:self.TOP_N_LARGE]:
            size_gb = info["total_size"] / (1024**3)
            self.findings.append(Finding(
                id=self._next_id(),
                category="large_folder",
                reason=f"Folder is {size_gb:.1f} GB ({info['file_count']} files)",
                paths=[path],
                total_bytes=info["total_size"]
            ))

    def _analyze_old_large_folders(self):
        """Find large folders that haven't been modified in a long time."""
        now = datetime.now()

        for path, info in self.folders.items():
            if info["total_size"] < self.LARGE_FOLDER_THRESHOLD:
                continue
            if not info["last_modified"]:
                continue

            last_mod = datetime.fromisoformat(info["last_modified"])
            days_old = (now - last_mod).days

            if days_old > self.OLD_DAYS_THRESHOLD:
                size_gb = info["total_size"] / (1024**3)
                self.findings.append(Finding(
                    id=self._next_id(),
                    category="old_large_folder",
                    reason=f"Folder is {size_gb:.1f} GB and last modified {days_old} days ago",
                    paths=[path],
                    total_bytes=info["total_size"]
                ))
            elif days_old <= self.RECENT_DAYS_THRESHOLD and info["total_size"] >= self.LARGE_FOLDER_THRESHOLD * 2:
                # Large and recently modified
                size_gb = info["total_size"] / (1024**3)
                self.findings.append(Finding(
                    id=self._next_id(),
                    category="active_large_folder",
                    reason=f"Folder is {size_gb:.1f} GB and was modified within the last {days_old} days",
                    paths=[path],
                    total_bytes=info["total_size"]
                ))

    def _analyze_cache_candidates(self):
        """Find folders matching cache/regenerable patterns."""
        for path, info in self.folders.items():
            folder_name = os.path.basename(path).lower()

            # Check cache patterns
            is_cache = any(pattern.lower() == folder_name for pattern in CACHE_FOLDER_PATTERNS)

            # Check temp paths
            if not is_cache:
                is_cache = "\\temp\\" in path.lower() or "\\tmp\\" in path.lower()

            if is_cache and info["total_size"] > 0:
                size_mb = info["total_size"] / (1024**2)
                self.findings.append(Finding(
                    id=self._next_id(),
                    category="cache_candidate",
                    reason=f"Matches known cache/regenerable pattern ({size_mb:.1f} MB)",
                    paths=[path],
                    total_bytes=info["total_size"]
                ))

    def _analyze_duplicate_folder_candidates(self):
        """Find folders with same name and similar size (cheap heuristic)."""
        # Group folders by name
        by_name: dict[str, list[tuple[str, dict]]] = defaultdict(list)

        for path, info in self.folders.items():
            name = os.path.basename(path).lower()
            if name and info["total_size"] > 10 * 1024 * 1024:  # Only >10MB
                by_name[name].append((path, info))

        # Find duplicates
        for name, candidates in by_name.items():
            if len(candidates) < 2:
                continue

            # Check for similar sizes (within 10%)
            candidates.sort(key=lambda x: x[1]["total_size"], reverse=True)

            groups = []
            for path, info in candidates:
                placed = False
                for group in groups:
                    ref_size = group[0][1]["total_size"]
                    if ref_size > 0:
                        diff = abs(info["total_size"] - ref_size) / ref_size
                        if diff <= 0.10:  # Within 10%
                            group.append((path, info))
                            placed = True
                            break
                if not placed:
                    groups.append([(path, info)])

            # Report groups with 2+ similar folders
            for group in groups:
                if len(group) >= 2:
                    paths = [p for p, _ in group]
                    total_size = sum(i["total_size"] for _, i in group)
                    # Reclaimable = all but one
                    reclaimable = total_size - group[0][1]["total_size"]

                    self.findings.append(Finding(
                        id=self._next_id(),
                        category="duplicate_folder_candidate",
                        reason=f"{len(group)} folders named '{name}' with similar sizes",
                        paths=paths,
                        total_bytes=reclaimable
                    ))

    def _analyze_duplicate_file_candidates(self):
        """Find files with same name and size."""
        # Group by (filename, size)
        by_key: dict[tuple[str, int], list[str]] = defaultdict(list)

        for file in self.files:
            filename = os.path.basename(file["path"])
            size = file["size_bytes"]
            if size > 1024 * 1024:  # Only >1MB files
                by_key[(filename, size)].append(file["path"])

        # Report duplicates
        for (filename, size), paths in by_key.items():
            if len(paths) >= 2:
                reclaimable = size * (len(paths) - 1)
                size_mb = size / (1024**2)

                self.findings.append(Finding(
                    id=self._next_id(),
                    category="duplicate_file_candidate",
                    reason=f"{len(paths)} files named '{filename}' ({size_mb:.1f} MB each)",
                    paths=paths,
                    total_bytes=reclaimable
                ))

    def _analyze_cold_archive_candidates(self):
        """Find large folders not accessed in a long time."""
        now = datetime.now()

        for path, info in self.folders.items():
            if info["total_size"] < self.LARGE_FOLDER_THRESHOLD:
                continue
            if not info["last_accessed"]:
                continue

            last_access = datetime.fromisoformat(info["last_accessed"])
            days_since_access = (now - last_access).days

            if days_since_access > self.OLD_DAYS_THRESHOLD:
                size_gb = info["total_size"] / (1024**3)
                self.findings.append(Finding(
                    id=self._next_id(),
                    category="cold_archive_candidate",
                    reason=f"{size_gb:.1f} GB, not accessed in {days_since_access} days",
                    paths=[path],
                    total_bytes=info["total_size"]
                ))

    def get_extension_summary(self) -> list[ExtensionSummary]:
        """Get summary of files by extension."""
        by_ext: dict[str, dict] = defaultdict(lambda: {"count": 0, "size": 0})

        for file in self.files:
            ext = file["extension"] or "(no extension)"
            by_ext[ext]["count"] += 1
            by_ext[ext]["size"] += file["size_bytes"]

        summaries = [
            ExtensionSummary(
                extension=ext,
                file_count=data["count"],
                total_bytes=data["size"]
            )
            for ext, data in by_ext.items()
        ]

        # Sort by total size descending
        summaries.sort(key=lambda x: x.total_bytes, reverse=True)
        return summaries

# ============================================================================
# FOLDER COMPARATOR
# ============================================================================

class FolderComparator:
    """
    Compares two directory trees and identifies differences.
    """

    def __init__(self, source_path: str, target_path: str, deep_scan: bool = False):
        self.source_path = source_path
        self.target_path = target_path
        self.deep_scan = deep_scan
        self.summary = ComparisonSummary()

    def _get_relative_path(self, full_path: str, root: str) -> str:
        """Get path relative to root."""
        return os.path.relpath(full_path, root)

    def _hash_file(self, file_path: str) -> Optional[str]:
        """Compute SHA256 hash of a file."""
        import hashlib
        try:
            sha256 = hashlib.sha256()
            with open(file_path, 'rb') as f:
                for chunk in iter(lambda: f.read(8192), b''):
                    sha256.update(chunk)
            return sha256.hexdigest()
        except (PermissionError, OSError):
            return None

    def _build_file_index(self, root_path: str) -> dict[str, dict]:
        """Build an index of all files keyed by relative path."""
        index = {}
        for root, dirs, files in os.walk(root_path, topdown=True):
            # Skip ignored directories
            dirs[:] = [d for d in dirs if not any(
                ignore.lower() in os.path.join(root, d).lower()
                for ignore in IGNORE_PATHS
            )]

            for filename in files:
                try:
                    file_path = os.path.join(root, filename)
                    rel_path = sanitize_string(self._get_relative_path(file_path, root_path))
                    stat = os.stat(file_path)

                    index[rel_path] = {
                        "full_path": file_path,
                        "size": stat.st_size,
                        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        "is_dir": False,
                    }
                except (PermissionError, OSError):
                    continue

            # Also index directories
            for dirname in dirs:
                try:
                    dir_path = os.path.join(root, dirname)
                    rel_path = sanitize_string(self._get_relative_path(dir_path, root_path))
                    stat = os.stat(dir_path)

                    index[rel_path] = {
                        "full_path": dir_path,
                        "size": 0,  # Will be calculated
                        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        "is_dir": True,
                    }
                except (PermissionError, OSError):
                    continue

        return index

    def _compare_files(
        self,
        rel_path: str,
        source_info: dict,
        target_info: dict
    ) -> str:
        """Compare two files and return status."""
        # Size differs = modified
        if source_info["size"] != target_info["size"]:
            return "modified"

        # Same size, check dates
        if source_info["modified"] != target_info["modified"]:
            # If deep scan, verify with hash
            if self.deep_scan:
                source_hash = self._hash_file(source_info["full_path"])
                target_hash = self._hash_file(target_info["full_path"])
                if source_hash and target_hash and source_hash == target_hash:
                    return "identical"
            return "modified"

        # Same size and date
        if self.deep_scan:
            source_hash = self._hash_file(source_info["full_path"])
            target_hash = self._hash_file(target_info["full_path"])
            if source_hash and target_hash and source_hash != target_hash:
                return "modified"

        return "identical"

    def compare(self) -> tuple[list[ComparisonItem], ComparisonSummary]:
        """
        Compare source and target directories.
        Returns (tree, summary).
        """
        logger.info(f"Comparing: {self.source_path} vs {self.target_path}")

        # Build indexes
        source_index = self._build_file_index(self.source_path)
        target_index = self._build_file_index(self.target_path)

        all_paths = set(source_index.keys()) | set(target_index.keys())
        items_by_path: dict[str, ComparisonItem] = {}

        for rel_path in sorted(all_paths):
            in_source = rel_path in source_index
            in_target = rel_path in target_index

            source_info = source_index.get(rel_path, {})
            target_info = target_index.get(rel_path, {})

            name = os.path.basename(rel_path)
            is_dir = source_info.get("is_dir", False) or target_info.get("is_dir", False)

            if in_source and in_target:
                if is_dir:
                    status = "identical"  # Will be updated based on children
                else:
                    status = self._compare_files(rel_path, source_info, target_info)
            elif in_source:
                status = "missing_from_target"
            else:
                status = "extra_in_target"

            # Update summary (only for files)
            if not is_dir:
                if status == "identical":
                    self.summary.identical += 1
                elif status == "modified":
                    self.summary.modified += 1
                elif status == "missing_from_target":
                    self.summary.missing_from_target += 1
                elif status == "extra_in_target":
                    self.summary.extra_in_target += 1

            self.summary.total_source_size += source_info.get("size", 0)
            self.summary.total_target_size += target_info.get("size", 0)

            item = ComparisonItem(
                name=sanitize_string(name),
                relative_path=sanitize_string(rel_path),
                item_type="folder" if is_dir else "file",
                status=status,
                source_size=source_info.get("size") if in_source else None,
                target_size=target_info.get("size") if in_target else None,
                source_modified=source_info.get("modified") if in_source else None,
                target_modified=target_info.get("modified") if in_target else None,
                children=[] if is_dir else None,
                difference_count=0
            )

            items_by_path[rel_path] = item

        # Build tree structure
        root_items: list[ComparisonItem] = []

        for rel_path, item in sorted(items_by_path.items(), key=lambda x: x[0]):
            parent_path = os.path.dirname(rel_path)

            if parent_path and parent_path in items_by_path:
                parent = items_by_path[parent_path]
                if parent.children is not None:
                    parent.children.append(item)
                    # Propagate difference counts up
                    if item.status != "identical" or item.difference_count > 0:
                        parent.difference_count += 1 + item.difference_count
                        if parent.status == "identical":
                            parent.status = "modified"  # Has different children
            else:
                root_items.append(item)

        logger.info(f"Comparison complete: {self.summary}")
        return root_items, self.summary

# ============================================================================
# API ENDPOINTS
# ============================================================================

@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}

@app.get("/api/scan/stream")
async def scan_stream(root_path: str):
    """Stream scan progress via Server-Sent Events."""

    if not os.path.exists(root_path):
        raise HTTPException(status_code=400, detail=f"Path does not exist: {root_path}")
    if not os.path.isdir(root_path):
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {root_path}")

    async def event_generator():
        scan_id = str(uuid.uuid4())
        started_at = datetime.now()

        progress_queue = asyncio.Queue()

        async def progress_callback(data):
            await progress_queue.put(data)

        async def scanner_task():
            scanner = DiskScanner(root_path, progress_callback)
            return await scanner.scan_async()

        scan_task = asyncio.create_task(scanner_task())

        # Stream progress events
        while not scan_task.done():
            try:
                progress_data = await asyncio.wait_for(progress_queue.get(), timeout=0.1)
                progress_data['scan_id'] = scan_id
                progress_data['event_type'] = 'progress'
                yield f"data: {json.dumps(progress_data)}\n\n"
            except asyncio.TimeoutError:
                continue

        # Get scan results
        files, folders = await scan_task
        completed_at = datetime.now()

        # Store scan data
        total_files = len(files)
        total_folders = len(folders)
        total_size = sum(f["size_bytes"] for f in files)

        scan_data = ScanData()
        scan_data.files = files
        scan_data.folders = folders
        scan_data.scan_info = ScanResponse(
            scan_id=scan_id,
            root_path=root_path,
            started_at=started_at.isoformat(),
            completed_at=completed_at.isoformat(),
            total_files=total_files,
            total_folders=total_folders,
            total_size_bytes=total_size
        )
        scans[scan_id] = scan_data

        # Send completion event
        completion_data = {
            "scan_id": scan_id,
            "event_type": "complete",
            "scan_response": scan_data.scan_info.dict()
        }
        yield f"data: {json.dumps(completion_data)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive"
        }
    )

@app.post("/api/scan", response_model=ScanResponse)
async def start_scan(request: ScanRequest):
    """Start a new scan of the specified path."""
    root_path = request.root_path

    # Validate path
    if not os.path.exists(root_path):
        raise HTTPException(status_code=400, detail=f"Path does not exist: {root_path}")
    if not os.path.isdir(root_path):
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {root_path}")

    scan_id = str(uuid.uuid4())
    started_at = datetime.now()

    # Perform scan
    scanner = DiskScanner(root_path)
    files, folders = scanner.scan()

    completed_at = datetime.now()

    # Calculate totals
    total_files = len(files)
    total_folders = len(folders)
    total_size = sum(f["size_bytes"] for f in files)

    # Store scan data
    scan_data = ScanData()
    scan_data.files = files
    scan_data.folders = folders
    scan_data.scan_info = ScanResponse(
        scan_id=scan_id,
        root_path=root_path,
        started_at=started_at.isoformat(),
        completed_at=completed_at.isoformat(),
        total_files=total_files,
        total_folders=total_folders,
        total_size_bytes=total_size
    )
    scans[scan_id] = scan_data

    return scan_data.scan_info

@app.get("/api/findings")
async def get_findings(
    scan_id: str,
    category: Optional[str] = None,
    risk: Optional[str] = None,
    min_score: Optional[float] = None
) -> list[Finding]:
    """Get findings for a scan with optional filters."""
    if scan_id not in scans:
        raise HTTPException(status_code=404, detail=f"Scan not found: {scan_id}")

    scan_data = scans[scan_id]

    # Run analysis
    analyzer = Analyzer(scan_data.files, scan_data.folders)
    findings = analyzer.analyze()

    # Apply filters
    if category:
        findings = [f for f in findings if f.category == category]
    if risk:
        findings = [f for f in findings if f.risk_level == risk]
    if min_score is not None:
        findings = [f for f in findings if f.score >= min_score]

    return findings

@app.get("/api/extensions-summary")
async def get_extensions_summary(scan_id: str) -> list[ExtensionSummary]:
    """Get extension summary for a scan."""
    if scan_id not in scans:
        raise HTTPException(status_code=404, detail=f"Scan not found: {scan_id}")

    scan_data = scans[scan_id]
    analyzer = Analyzer(scan_data.files, scan_data.folders)
    return analyzer.get_extension_summary()

# ============================================================================
# SNAPSHOT ENDPOINTS
# ============================================================================

@app.post("/api/snapshots")
async def save_snapshot(request: SnapshotRequest, db: Session = Depends(get_db)):
    """Save a snapshot of scan results."""
    scan_id = request.scan_id

    if scan_id not in scans:
        raise HTTPException(status_code=404, detail=f"Scan not found: {scan_id}")

    scan_data = scans[scan_id]

    # Get findings and extensions
    analyzer = Analyzer(scan_data.files, scan_data.folders)
    findings = analyzer.analyze()
    extensions = analyzer.get_extension_summary()

    # Generate snapshot ID
    snapshot_id = f"snapshot-{uuid.uuid4()}"

    # Create snapshot
    snapshot = serialize_snapshot(
        snapshot_id,
        scan_id,
        request.root_path,
        findings,
        extensions,
        scan_data.scan_info
    )

    # Save to database
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)

    return deserialize_snapshot(snapshot)

@app.get("/api/snapshots")
async def get_snapshots(db: Session = Depends(get_db)):
    """Get all saved snapshots."""
    snapshots = db.query(SnapshotDB).order_by(SnapshotDB.saved_at.desc()).all()
    return [deserialize_snapshot(s) for s in snapshots]

@app.get("/api/snapshots/{snapshot_id}")
async def get_snapshot(snapshot_id: str, db: Session = Depends(get_db)):
    """Get a specific snapshot by ID."""
    snapshot = db.query(SnapshotDB).filter(SnapshotDB.id == snapshot_id).first()

    if not snapshot:
        raise HTTPException(status_code=404, detail=f"Snapshot not found: {snapshot_id}")

    return deserialize_snapshot(snapshot)

@app.put("/api/snapshots/{snapshot_id}")
async def update_snapshot(snapshot_id: str, db: Session = Depends(get_db)):
    """Update a snapshot by re-scanning its path."""
    snapshot = db.query(SnapshotDB).filter(SnapshotDB.id == snapshot_id).first()

    if not snapshot:
        raise HTTPException(status_code=404, detail=f"Snapshot not found: {snapshot_id}")

    root_path = snapshot.root_path

    # Validate path still exists
    if not os.path.exists(root_path):
        raise HTTPException(status_code=400, detail=f"Path no longer exists: {root_path}")
    if not os.path.isdir(root_path):
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {root_path}")

    # Perform new scan
    new_scan_id = str(uuid.uuid4())
    started_at = datetime.now()

    scanner = DiskScanner(root_path)
    files, folders = scanner.scan()

    completed_at = datetime.now()

    # Calculate totals
    total_files = len(files)
    total_folders = len(folders)
    total_size = sum(f["size_bytes"] for f in files)

    # Create new scan info
    scan_info = ScanResponse(
        scan_id=new_scan_id,
        root_path=root_path,
        started_at=started_at.isoformat(),
        completed_at=completed_at.isoformat(),
        total_files=total_files,
        total_folders=total_folders,
        total_size_bytes=total_size
    )

    # Get findings and extensions
    analyzer = Analyzer(files, folders)
    findings = analyzer.analyze()
    extensions = analyzer.get_extension_summary()

    # Update snapshot
    snapshot.scan_id = new_scan_id
    snapshot.findings_json = json.dumps([f.dict() for f in findings])
    snapshot.extensions_json = json.dumps([e.dict() for e in extensions])
    snapshot.scan_info_json = json.dumps(scan_info.dict())
    snapshot.total_files = total_files
    snapshot.total_folders = total_folders
    snapshot.total_size_bytes = total_size
    snapshot.saved_at = datetime.utcnow()

    db.commit()
    db.refresh(snapshot)

    return deserialize_snapshot(snapshot)

@app.delete("/api/snapshots/{snapshot_id}")
async def delete_snapshot(snapshot_id: str, db: Session = Depends(get_db)):
    """Delete a snapshot."""
    snapshot = db.query(SnapshotDB).filter(SnapshotDB.id == snapshot_id).first()

    if not snapshot:
        raise HTTPException(status_code=404, detail=f"Snapshot not found: {snapshot_id}")

    db.delete(snapshot)
    db.commit()

    return {"message": "Snapshot deleted successfully"}

# ============================================================================
# COMPARISON ENDPOINTS
# ============================================================================

@app.post("/api/compare")
async def compare_directories(request: ComparisonRequest):
    """Compare two directories and return differences."""
    source_path = request.source_path
    target_path = request.target_path

    # Validate paths
    if not os.path.exists(source_path):
        raise HTTPException(status_code=400, detail=f"Source path does not exist: {source_path}")
    if not os.path.isdir(source_path):
        raise HTTPException(status_code=400, detail=f"Source path is not a directory: {source_path}")
    if not os.path.exists(target_path):
        raise HTTPException(status_code=400, detail=f"Target path does not exist: {target_path}")
    if not os.path.isdir(target_path):
        raise HTTPException(status_code=400, detail=f"Target path is not a directory: {target_path}")

    comparison_id = str(uuid.uuid4())

    # Run comparison
    comparator = FolderComparator(source_path, target_path, request.deep_scan)
    tree, summary = comparator.compare()

    return ComparisonResponse(
        comparison_id=comparison_id,
        source_path=source_path,
        target_path=target_path,
        summary=summary,
        tree=tree,
        deep_scan=request.deep_scan,
        completed_at=datetime.now().isoformat()
    )


@app.post("/api/snapshots/comparison")
async def save_comparison_snapshot(
    source_path: str,
    target_path: str,
    comparison_id: str,
    db: Session = Depends(get_db)
):
    """Save a comparison as a snapshot."""
    # Re-run comparison to get fresh data
    comparator = FolderComparator(source_path, target_path, deep_scan=False)
    tree, summary = comparator.compare()

    snapshot_id = f"comparison-{uuid.uuid4()}"

    # Create minimal scan info for compatibility
    scan_info = {
        "scan_id": comparison_id,
        "root_path": source_path,
        "started_at": datetime.now().isoformat(),
        "completed_at": datetime.now().isoformat(),
        "total_files": summary.identical + summary.modified + summary.missing_from_target,
        "total_folders": 0,
        "total_size_bytes": summary.total_source_size
    }

    snapshot = SnapshotDB(
        id=snapshot_id,
        scan_id=comparison_id,
        root_path=source_path,
        findings_json=json.dumps([]),
        extensions_json=json.dumps([]),
        scan_info_json=json.dumps(scan_info),
        total_files=scan_info["total_files"],
        total_folders=0,
        total_size_bytes=summary.total_source_size,
        saved_at=datetime.utcnow(),
        snapshot_type="comparison",
        target_path=target_path,
        comparison_json=json.dumps([item.dict() for item in tree]),
        comparison_summary_json=json.dumps(summary.dict())
    )

    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)

    return deserialize_snapshot(snapshot)


@app.put("/api/snapshots/comparison/{snapshot_id}")
async def update_comparison_snapshot(snapshot_id: str, db: Session = Depends(get_db)):
    """Update a comparison snapshot by re-running the comparison."""
    snapshot = db.query(SnapshotDB).filter(SnapshotDB.id == snapshot_id).first()

    if not snapshot:
        raise HTTPException(status_code=404, detail=f"Snapshot not found: {snapshot_id}")
    if snapshot.snapshot_type != "comparison":
        raise HTTPException(status_code=400, detail="Not a comparison snapshot")

    source_path = snapshot.root_path
    target_path = snapshot.target_path

    # Validate paths still exist
    if not os.path.exists(source_path):
        raise HTTPException(status_code=400, detail=f"Source path no longer exists: {source_path}")
    if not os.path.exists(target_path):
        raise HTTPException(status_code=400, detail=f"Target path no longer exists: {target_path}")

    # Re-run comparison
    comparator = FolderComparator(source_path, target_path, deep_scan=False)
    tree, summary = comparator.compare()

    # Update snapshot
    snapshot.comparison_json = json.dumps([item.dict() for item in tree])
    snapshot.comparison_summary_json = json.dumps(summary.dict())
    snapshot.total_files = summary.identical + summary.modified + summary.missing_from_target
    snapshot.total_size_bytes = summary.total_source_size
    snapshot.saved_at = datetime.utcnow()

    db.commit()
    db.refresh(snapshot)

    return deserialize_snapshot(snapshot)

# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001)

# TODO: Implement incremental scanning using Windows filesystem journals (USN Journal)
# TODO: Add more sophisticated ignore rules with regex patterns
# TODO: Implement content hashing for exact duplicate detection
# TODO: Add fuzzy media matching for similar images/videos
# TODO: Implement treemap data generation for visualization
# TODO: Add timeline tracking for disk changes over time
# TODO: Implement rule engine for custom detection rules
# TODO: Add cloud storage integration (OneDrive, Google Drive, etc.)
# TODO: Implement smart orphan detection by inspecting application metadata
# TODO: Add undo/quarantine mechanism for safer deletions
