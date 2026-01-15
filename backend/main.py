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
