# Folder Comparison Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add directory comparison to identify duplicates and differences between two folders for backup validation.

**Architecture:** Extend existing DiskScanner to scan two directories, add FolderComparator class to build comparison tree, create ComparisonResults React component with collapsible tree UI, extend database schema for comparison snapshots.

**Tech Stack:** Python/FastAPI backend, React/TypeScript frontend, SQLAlchemy/SQLite database

---

## Task 1: Extend Database Schema for Comparison Snapshots

**Files:**
- Modify: `backend/database.py:26-42`

**Step 1: Add comparison fields to SnapshotDB model**

In `backend/database.py`, add new columns to `SnapshotDB` class after line 41:

```python
class SnapshotDB(Base):
    """Database model for scan snapshots."""
    __tablename__ = "snapshots"

    id = Column(String, primary_key=True, index=True)
    scan_id = Column(String, nullable=False)
    root_path = Column(String, nullable=False, index=True)
    findings_json = Column(Text, nullable=False)  # JSON serialized findings
    extensions_json = Column(Text, nullable=False)  # JSON serialized extensions
    scan_info_json = Column(Text, nullable=False)  # JSON serialized scan info
    saved_at = Column(DateTime, default=datetime.utcnow)

    # Metadata fields for quick display
    total_files = Column(Integer)
    total_folders = Column(Integer)
    total_size_bytes = Column(Integer)

    # NEW: Comparison snapshot fields
    snapshot_type = Column(String, default="scan")  # "scan" or "comparison"
    target_path = Column(String, nullable=True)  # Only for comparisons
    comparison_json = Column(Text, nullable=True)  # Comparison tree data
    comparison_summary_json = Column(Text, nullable=True)  # Summary counts
```

**Step 2: Update serialize_snapshot function**

Update the function signature and body to handle comparison snapshots:

```python
def serialize_snapshot(
    snapshot_id: str,
    scan_id: str,
    root_path: str,
    findings: list,
    extensions: list,
    scan_info: dict,
    snapshot_type: str = "scan",
    target_path: str = None,
    comparison_data: dict = None,
    comparison_summary: dict = None
) -> SnapshotDB:
    """Create a SnapshotDB instance from scan data."""
    return SnapshotDB(
        id=snapshot_id,
        scan_id=scan_id,
        root_path=root_path,
        findings_json=json.dumps([f.dict() if hasattr(f, 'dict') else f for f in findings]),
        extensions_json=json.dumps([e.dict() if hasattr(e, 'dict') else e for e in extensions]),
        scan_info_json=json.dumps(scan_info.dict() if hasattr(scan_info, 'dict') else scan_info),
        total_files=scan_info.get('total_files') if isinstance(scan_info, dict) else scan_info.total_files,
        total_folders=scan_info.get('total_folders') if isinstance(scan_info, dict) else scan_info.total_folders,
        total_size_bytes=scan_info.get('total_size_bytes') if isinstance(scan_info, dict) else scan_info.total_size_bytes,
        saved_at=datetime.utcnow(),
        snapshot_type=snapshot_type,
        target_path=target_path,
        comparison_json=json.dumps(comparison_data) if comparison_data else None,
        comparison_summary_json=json.dumps(comparison_summary) if comparison_summary else None
    )
```

**Step 3: Update deserialize_snapshot function**

```python
def deserialize_snapshot(snapshot_db: SnapshotDB) -> dict:
    """Convert SnapshotDB to a dictionary for API response."""
    result = {
        "id": snapshot_db.id,
        "scan_id": snapshot_db.scan_id,
        "root_path": snapshot_db.root_path,
        "findings": json.loads(snapshot_db.findings_json),
        "extensions": json.loads(snapshot_db.extensions_json),
        "scan_info": json.loads(snapshot_db.scan_info_json),
        "saved_at": snapshot_db.saved_at.isoformat(),
        "total_files": snapshot_db.total_files,
        "total_folders": snapshot_db.total_folders,
        "total_size_bytes": snapshot_db.total_size_bytes,
        "snapshot_type": snapshot_db.snapshot_type or "scan",
        "target_path": snapshot_db.target_path,
    }

    if snapshot_db.comparison_json:
        result["comparison"] = json.loads(snapshot_db.comparison_json)
    if snapshot_db.comparison_summary_json:
        result["comparison_summary"] = json.loads(snapshot_db.comparison_summary_json)

    return result
```

**Step 4: Delete old database and restart to apply schema changes**

Run:
```bash
cd backend
rm disk_intelligence.db
python -c "from database import Base, engine; Base.metadata.create_all(bind=engine)"
```

**Step 5: Commit**

```bash
git add backend/database.py
git commit -m "feat(db): extend schema for comparison snapshots

Add snapshot_type, target_path, comparison_json, and comparison_summary_json
columns to support storing folder comparison results alongside regular scans."
```

---

## Task 2: Add FolderComparator Class to Backend

**Files:**
- Modify: `backend/main.py` (add after Analyzer class, around line 595)

**Step 1: Add Pydantic models for comparison**

Add these models after the existing models (around line 100):

```python
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
```

**Step 2: Add FolderComparator class**

Add after the Analyzer class (around line 595):

```python
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
                    rel_path = self._get_relative_path(file_path, root_path)
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
                    rel_path = self._get_relative_path(dir_path, root_path)
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

            # Update summary
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
                name=name,
                relative_path=rel_path,
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
```

**Step 3: Commit**

```bash
git add backend/main.py
git commit -m "feat(backend): add FolderComparator class

Compares two directories and builds a tree structure showing:
- identical files (same size/date, optionally hash verified)
- modified files (different size or date)
- missing files (only in source)
- extra files (only in target)

Supports optional deep scan with SHA256 hash verification."
```

---

## Task 3: Add Comparison API Endpoints

**Files:**
- Modify: `backend/main.py` (add after snapshot endpoints, around line 886)

**Step 1: Add comparison endpoint**

```python
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
```

**Step 2: Commit**

```bash
git add backend/main.py
git commit -m "feat(api): add comparison endpoints

- POST /api/compare - compare two directories
- POST /api/snapshots/comparison - save comparison as snapshot
- PUT /api/snapshots/comparison/{id} - update comparison snapshot"
```

---

## Task 4: Add Comparison Types and API Functions to Frontend

**Files:**
- Modify: `frontend/src/api.ts`

**Step 1: Add comparison types**

Add after the Snapshot interface (around line 72):

```typescript
/** Status of a compared item */
export type ComparisonStatus =
  | "identical"
  | "modified"
  | "missing_from_target"
  | "extra_in_target";

/** A single item in the comparison tree */
export interface ComparisonItem {
  name: string;
  relativePath: string;
  itemType: "file" | "folder";
  status: ComparisonStatus;
  sourceSize: number | null;
  targetSize: number | null;
  sourceModified: string | null;
  targetModified: string | null;
  sourceHash: string | null;
  targetHash: string | null;
  children: ComparisonItem[] | null;
  differenceCount: number;
}

/** Summary of comparison results */
export interface ComparisonSummary {
  identical: number;
  modified: number;
  missingFromTarget: number;
  extraInTarget: number;
  totalSourceSize: number;
  totalTargetSize: number;
}

/** Response from a comparison */
export interface ComparisonResponse {
  comparisonId: string;
  sourcePath: string;
  targetPath: string;
  summary: ComparisonSummary;
  tree: ComparisonItem[];
  deepScan: boolean;
  completedAt: string;
}

/** Extended snapshot that may include comparison data */
export interface ComparisonSnapshot extends Snapshot {
  snapshotType: "scan" | "comparison";
  targetPath?: string;
  comparison?: ComparisonItem[];
  comparisonSummary?: ComparisonSummary;
}
```

**Step 2: Add transform function for comparison items**

```typescript
/**
 * Transform snake_case ComparisonItem to camelCase (recursive)
 */
function transformComparisonItem(item: any): ComparisonItem {
  return {
    name: item.name,
    relativePath: item.relative_path,
    itemType: item.item_type,
    status: item.status,
    sourceSize: item.source_size,
    targetSize: item.target_size,
    sourceModified: item.source_modified,
    targetModified: item.target_modified,
    sourceHash: item.source_hash,
    targetHash: item.target_hash,
    children: item.children?.map(transformComparisonItem) || null,
    differenceCount: item.difference_count || 0,
  };
}

/**
 * Transform snake_case ComparisonSummary to camelCase
 */
function transformComparisonSummary(summary: any): ComparisonSummary {
  return {
    identical: summary.identical || 0,
    modified: summary.modified || 0,
    missingFromTarget: summary.missing_from_target || 0,
    extraInTarget: summary.extra_in_target || 0,
    totalSourceSize: summary.total_source_size || 0,
    totalTargetSize: summary.total_target_size || 0,
  };
}
```

**Step 3: Add comparison API functions**

```typescript
/**
 * Compare two directories.
 * @param sourcePath - The source directory path.
 * @param targetPath - The target directory path.
 * @param deepScan - Whether to verify with file hashes.
 * @returns Comparison results.
 */
export async function compareDirectories(
  sourcePath: string,
  targetPath: string,
  deepScan: boolean = false
): Promise<ComparisonResponse> {
  const data = await apiFetch<any>("/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_path: sourcePath,
      target_path: targetPath,
      deep_scan: deepScan,
    }),
  });

  return {
    comparisonId: data.comparison_id,
    sourcePath: data.source_path,
    targetPath: data.target_path,
    summary: transformComparisonSummary(data.summary),
    tree: data.tree.map(transformComparisonItem),
    deepScan: data.deep_scan,
    completedAt: data.completed_at,
  };
}

/**
 * Save a comparison as a snapshot.
 */
export async function saveComparisonSnapshot(
  sourcePath: string,
  targetPath: string,
  comparisonId: string
): Promise<ComparisonSnapshot> {
  const params = new URLSearchParams({
    source_path: sourcePath,
    target_path: targetPath,
    comparison_id: comparisonId,
  });

  const item = await apiFetch<any>(`/snapshots/comparison?${params}`, {
    method: "POST",
  });

  return transformSnapshot(item) as ComparisonSnapshot;
}

/**
 * Update a comparison snapshot by re-running the comparison.
 */
export async function updateComparisonSnapshot(
  snapshotId: string
): Promise<ComparisonSnapshot> {
  const item = await apiFetch<any>(`/snapshots/comparison/${snapshotId}`, {
    method: "PUT",
  });

  return transformSnapshot(item) as ComparisonSnapshot;
}

/**
 * Transform snapshot with comparison fields
 */
function transformSnapshot(item: any): ComparisonSnapshot {
  const base = {
    id: item.id,
    scanId: item.scan_id,
    rootPath: item.root_path,
    findings: (item.findings || []).map(transformFinding),
    extensions: (item.extensions || []).map(transformExtension),
    scanInfo: item.scan_info ? {
      scanId: item.scan_info.scan_id,
      rootPath: item.scan_info.root_path,
      startedAt: item.scan_info.started_at,
      completedAt: item.scan_info.completed_at,
      totalFiles: item.scan_info.total_files,
      totalFolders: item.scan_info.total_folders,
      totalSizeBytes: item.scan_info.total_size_bytes,
    } : {} as ScanResponse,
    savedAt: item.saved_at,
    totalFiles: item.total_files,
    totalFolders: item.total_folders,
    totalSizeBytes: item.total_size_bytes,
    snapshotType: item.snapshot_type || "scan",
    targetPath: item.target_path,
  } as ComparisonSnapshot;

  if (item.comparison) {
    base.comparison = item.comparison.map(transformComparisonItem);
  }
  if (item.comparison_summary) {
    base.comparisonSummary = transformComparisonSummary(item.comparison_summary);
  }

  return base;
}
```

**Step 4: Update existing getSnapshots to use transformSnapshot**

Update the `getSnapshots` function to use the new `transformSnapshot`:

```typescript
export async function getSnapshots(): Promise<ComparisonSnapshot[]> {
  const data = await apiFetch<any[]>("/snapshots");
  return data.map(transformSnapshot);
}
```

**Step 5: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(api): add comparison types and API functions

- Add ComparisonItem, ComparisonSummary, ComparisonResponse types
- Add compareDirectories() for running comparisons
- Add saveComparisonSnapshot() and updateComparisonSnapshot()
- Update getSnapshots() to return comparison snapshots"
```

---

## Task 5: Update ScanControls for Comparison Mode

**Files:**
- Modify: `frontend/src/components/ScanControls.tsx`
- Modify: `frontend/src/components/ScanControls.css`

**Step 1: Add comparison state and props**

Update the interface and add state in `ScanControls.tsx`:

```typescript
export type ScanStatus = "idle" | "scanning" | "completed" | "error" | "comparing";

interface ScanControlsProps {
  onScanComplete: (scanId: string, scanInfo: ScanResponse) => void;
  onComparisonComplete: (result: ComparisonResponse) => void;
  status: ScanStatus;
  setStatus: (status: ScanStatus) => void;
  scanInfo: ScanResponse | null;
}
```

Add imports at top:

```typescript
import { scanWithProgress, compareDirectories, formatBytes } from "../api";
import type { ScanResponse, ComparisonResponse } from "../api";
```

Add state for comparison mode:

```typescript
const [compareMode, setCompareMode] = useState(false);
const [targetPath, setTargetPath] = useState("");
const [deepScan, setDeepScan] = useState(false);
const targetFileInputRef = useRef<HTMLInputElement>(null);
```

**Step 2: Add target directory selection handler**

```typescript
const handleTargetDirectorySelect = async () => {
  if (window.electronAPI) {
    try {
      const selectedPath = await window.electronAPI.selectDirectory();
      if (selectedPath) {
        setTargetPath(selectedPath);
      }
    } catch (err) {
      console.error('Failed to open directory dialog:', err);
      setError('Failed to open directory selection dialog');
    }
  } else {
    targetFileInputRef.current?.click();
  }
};

const handleTargetFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const files = e.target.files;
  if (files && files.length > 0) {
    const firstFile = files[0];
    const fullPath = (firstFile as any).path || firstFile.webkitRelativePath;
    if (fullPath) {
      const dirPath = fullPath.substring(0, fullPath.lastIndexOf('\\') || fullPath.lastIndexOf('/'));
      setTargetPath(dirPath || fullPath);
    }
  }
};
```

**Step 3: Add comparison handler**

```typescript
const handleCompare = async () => {
  if (!rootPath.trim() || !targetPath.trim()) {
    setError("Please select both source and target directories");
    return;
  }

  setError(null);
  setLogs([]);
  setStatus("comparing");
  setLogsExpanded(true);

  addLog(`Comparing: ${rootPath.trim()} vs ${targetPath.trim()}`, "info");
  if (deepScan) {
    addLog("Deep scan enabled - verifying file contents with hashes", "info");
  }

  try {
    const result = await compareDirectories(
      rootPath.trim(),
      targetPath.trim(),
      deepScan
    );

    setStatus("completed");
    addLog("Comparison completed successfully", "success");
    addLog(
      `Found: ${result.summary.identical} identical, ${result.summary.modified} modified, ` +
      `${result.summary.missingFromTarget} missing, ${result.summary.extraInTarget} extra`,
      "success"
    );
    onComparisonComplete(result);
  } catch (err) {
    setStatus("error");
    const errorMsg = err instanceof Error ? err.message : "Comparison failed";
    setError(errorMsg);
    addLog(`Error: ${errorMsg}`, "error");
  }
};
```

**Step 4: Update JSX to include comparison controls**

Replace the scan-input-row div and add comparison section:

```tsx
<div className="scan-input-row">
  {!window.electronAPI && (
    <input
      ref={fileInputRef}
      type="file"
      /* @ts-ignore */
      webkitdirectory=""
      directory=""
      multiple
      style={{ display: "none" }}
      onChange={handleFileInputChange}
    />
  )}
  <button
    className="select-directory-button"
    onClick={handleDirectorySelect}
    disabled={status === "scanning" || status === "comparing"}
  >
    {rootPath ? "Change Source" : "Select Source"}
  </button>
  {rootPath && (
    <div className="selected-path" title={rootPath}>
      {rootPath}
    </div>
  )}
  {!compareMode && (
    status === "scanning" ? (
      <button className="cancel-button" onClick={handleCancel}>
        Cancel Scan
      </button>
    ) : (
      <button
        className="scan-button"
        onClick={handleScan}
        disabled={!rootPath}
      >
        Scan & Analyze
      </button>
    )
  )}
</div>

<div className="compare-toggle">
  <label>
    <input
      type="checkbox"
      checked={compareMode}
      onChange={(e) => setCompareMode(e.target.checked)}
      disabled={status === "scanning" || status === "comparing"}
    />
    Compare with another folder
  </label>
</div>

{compareMode && (
  <div className="comparison-controls">
    <div className="scan-input-row">
      {!window.electronAPI && (
        <input
          ref={targetFileInputRef}
          type="file"
          /* @ts-ignore */
          webkitdirectory=""
          directory=""
          multiple
          style={{ display: "none" }}
          onChange={handleTargetFileInputChange}
        />
      )}
      <button
        className="select-directory-button target"
        onClick={handleTargetDirectorySelect}
        disabled={status === "scanning" || status === "comparing"}
      >
        {targetPath ? "Change Target" : "Select Target"}
      </button>
      {targetPath && (
        <div className="selected-path" title={targetPath}>
          {targetPath}
        </div>
      )}
      <button
        className="compare-button"
        onClick={handleCompare}
        disabled={!rootPath || !targetPath || status === "comparing"}
      >
        {status === "comparing" ? "Comparing..." : "Compare"}
      </button>
    </div>
    <div className="deep-scan-toggle">
      <label>
        <input
          type="checkbox"
          checked={deepScan}
          onChange={(e) => setDeepScan(e.target.checked)}
          disabled={status === "comparing"}
        />
        Deep scan (verify file contents)
      </label>
    </div>
  </div>
)}
```

**Step 5: Update status badge for comparing state**

```typescript
const getStatusBadge = () => {
  switch (status) {
    case "idle":
      return <span className="status-badge idle">Ready</span>;
    case "scanning":
      return <span className="status-badge scanning">Scanning...</span>;
    case "comparing":
      return <span className="status-badge scanning">Comparing...</span>;
    case "completed":
      return <span className="status-badge completed">Completed</span>;
    case "error":
      return <span className="status-badge error">Error</span>;
  }
};
```

**Step 6: Add CSS for comparison controls**

Add to `ScanControls.css`:

```css
/* Comparison Mode */
.compare-toggle {
  margin: 12px 0;
  padding: 8px 0;
}

.compare-toggle label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.95rem;
}

.compare-toggle input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.comparison-controls {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-light);
  border-radius: 8px;
  padding: 16px;
  margin-top: 8px;
}

.comparison-controls .scan-input-row {
  margin-bottom: 12px;
}

.select-directory-button.target {
  background: var(--accent-secondary, #6b9e78);
}

.select-directory-button.target:hover {
  background: var(--accent-secondary-dark, #5a8a66);
}

.compare-button {
  padding: 10px 24px;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary, #6b9e78));
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.compare-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.compare-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.deep-scan-toggle {
  margin-top: 8px;
}

.deep-scan-toggle label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.85rem;
}
```

**Step 7: Commit**

```bash
git add frontend/src/components/ScanControls.tsx frontend/src/components/ScanControls.css
git commit -m "feat(ui): add comparison mode to ScanControls

- Add checkbox to toggle comparison mode
- Add second directory picker for target folder
- Add deep scan option for hash verification
- Add Compare button and comparing status"
```

---

## Task 6: Create ComparisonResults Component

**Files:**
- Create: `frontend/src/components/ComparisonResults.tsx`
- Create: `frontend/src/components/ComparisonResults.css`

**Step 1: Create ComparisonResults.tsx**

```typescript
import { useState } from "react";
import type { ComparisonItem, ComparisonSummary } from "../api";
import { formatBytes } from "../api";
import "./ComparisonResults.css";

interface ComparisonResultsProps {
  sourcePath: string;
  targetPath: string;
  summary: ComparisonSummary;
  tree: ComparisonItem[];
  isSnapshot: boolean;
  onSaveSnapshot: () => void;
  onUpdateSnapshot: () => void;
  isSaving: boolean;
}

export function ComparisonResults({
  sourcePath,
  targetPath,
  summary,
  tree,
  isSnapshot,
  onSaveSnapshot,
  onUpdateSnapshot,
  isSaving,
}: ComparisonResultsProps) {
  const [showAll, setShowAll] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    // Initially expand folders with differences
    const expanded = new Set<string>();
    const findDifferent = (items: ComparisonItem[], path = "") => {
      for (const item of items) {
        const itemPath = path ? `${path}/${item.name}` : item.name;
        if (item.differenceCount > 0 || item.status !== "identical") {
          expanded.add(itemPath);
        }
        if (item.children) {
          findDifferent(item.children, itemPath);
        }
      }
    };
    findDifferent(tree);
    return expanded;
  });

  const toggleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "identical":
        return <span className="status-icon identical">=</span>;
      case "modified":
        return <span className="status-icon modified">≠</span>;
      case "missing_from_target":
        return <span className="status-icon missing">+</span>;
      case "extra_in_target":
        return <span className="status-icon extra">−</span>;
      default:
        return null;
    }
  };

  const getStatusLabel = (item: ComparisonItem) => {
    if (item.status === "modified" && item.sourceModified && item.targetModified) {
      const sourceDate = new Date(item.sourceModified);
      const targetDate = new Date(item.targetModified);
      if (sourceDate > targetDate) {
        return "Newer in source";
      } else if (targetDate > sourceDate) {
        return "Newer in target";
      }
      return "Size differs";
    }
    switch (item.status) {
      case "identical":
        return "Identical";
      case "modified":
        return "Modified";
      case "missing_from_target":
        return "Missing from target";
      case "extra_in_target":
        return "Only in target";
      default:
        return item.status;
    }
  };

  const renderItem = (item: ComparisonItem, path: string, depth: number) => {
    const itemPath = path ? `${path}/${item.name}` : item.name;
    const isExpanded = expandedPaths.has(itemPath);
    const isFolder = item.itemType === "folder";
    const hasDifferences = item.differenceCount > 0 || item.status !== "identical";

    // Filter out identical items if not showing all
    if (!showAll && item.status === "identical" && item.differenceCount === 0) {
      return null;
    }

    return (
      <div key={itemPath} className="comparison-item" style={{ marginLeft: depth * 20 }}>
        <div
          className={`item-row ${item.status} ${isFolder ? "folder" : "file"}`}
          onClick={() => isFolder && toggleExpand(itemPath)}
        >
          {isFolder && (
            <span className={`expand-icon ${isExpanded ? "expanded" : ""}`}>
              ▶
            </span>
          )}
          <span className="item-icon">{isFolder ? "📁" : "📄"}</span>
          <span className="item-name">{item.name}</span>
          {isFolder && item.differenceCount > 0 && (
            <span className="difference-badge">
              {item.differenceCount} difference{item.differenceCount !== 1 ? "s" : ""}
            </span>
          )}
          {!isFolder && (
            <span className="item-status">{getStatusLabel(item)}</span>
          )}
          {getStatusIcon(item.status)}
        </div>

        {!isFolder && hasDifferences && (
          <div className="item-details">
            {item.sourceSize !== null && (
              <div className="detail-row">
                <span className="detail-label">Source:</span>
                <span>{formatBytes(item.sourceSize)}</span>
                {item.sourceModified && (
                  <span className="detail-date">
                    {new Date(item.sourceModified).toLocaleString()}
                  </span>
                )}
              </div>
            )}
            {item.targetSize !== null && (
              <div className="detail-row">
                <span className="detail-label">Target:</span>
                <span>{formatBytes(item.targetSize)}</span>
                {item.targetModified && (
                  <span className="detail-date">
                    {new Date(item.targetModified).toLocaleString()}
                  </span>
                )}
              </div>
            )}
            {item.sourceSize === null && (
              <div className="detail-row only-target">
                <span className="detail-label">Only in target:</span>
                <span>{formatBytes(item.targetSize || 0)}</span>
              </div>
            )}
            {item.targetSize === null && (
              <div className="detail-row only-source">
                <span className="detail-label">Only in source:</span>
                <span>{formatBytes(item.sourceSize || 0)}</span>
              </div>
            )}
          </div>
        )}

        {isFolder && isExpanded && item.children && (
          <div className="item-children">
            {item.children.map((child) => renderItem(child, itemPath, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const totalDifferences =
    summary.modified + summary.missingFromTarget + summary.extraInTarget;

  return (
    <div className="comparison-results">
      <div className="comparison-header">
        <div className="comparison-paths">
          <span className="path-label">Source:</span>
          <span className="path-value">{sourcePath}</span>
          <span className="path-separator">↔</span>
          <span className="path-label">Target:</span>
          <span className="path-value">{targetPath}</span>
        </div>
        <button
          className="snapshot-action-btn"
          onClick={isSnapshot ? onUpdateSnapshot : onSaveSnapshot}
          disabled={isSaving}
        >
          {isSaving
            ? "Saving..."
            : isSnapshot
            ? "Update Comparison"
            : "Save Comparison"}
        </button>
      </div>

      <div className="comparison-summary">
        <div className="summary-item identical">
          <span className="summary-count">{summary.identical}</span>
          <span className="summary-label">Identical</span>
        </div>
        <div className="summary-item modified">
          <span className="summary-count">{summary.modified}</span>
          <span className="summary-label">Modified</span>
        </div>
        <div className="summary-item missing">
          <span className="summary-count">{summary.missingFromTarget}</span>
          <span className="summary-label">Missing</span>
        </div>
        <div className="summary-item extra">
          <span className="summary-count">{summary.extraInTarget}</span>
          <span className="summary-label">Extra</span>
        </div>
      </div>

      <div className="comparison-controls-bar">
        <button
          className={`view-toggle ${!showAll ? "active" : ""}`}
          onClick={() => setShowAll(false)}
        >
          Differences only ({totalDifferences})
        </button>
        <button
          className={`view-toggle ${showAll ? "active" : ""}`}
          onClick={() => setShowAll(true)}
        >
          Show all
        </button>
      </div>

      <div className="comparison-tree">
        {tree.map((item) => renderItem(item, "", 0))}
        {!showAll && totalDifferences === 0 && (
          <div className="no-differences">
            All files are identical! The folders match perfectly.
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Create ComparisonResults.css**

```css
.comparison-results {
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 12px;
  overflow: hidden;
}

.comparison-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-light);
}

.comparison-paths {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.path-label {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.path-value {
  color: var(--text-primary);
  font-weight: 500;
  font-size: 0.9rem;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path-separator {
  color: var(--accent-primary);
  font-weight: bold;
  margin: 0 8px;
}

.comparison-summary {
  display: flex;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-light);
}

.summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 24px;
  border-radius: 8px;
  min-width: 100px;
}

.summary-item.identical {
  background: rgba(107, 158, 120, 0.1);
}

.summary-item.modified {
  background: rgba(201, 166, 84, 0.1);
}

.summary-item.missing {
  background: rgba(84, 140, 201, 0.1);
}

.summary-item.extra {
  background: rgba(199, 107, 107, 0.1);
}

.summary-count {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-primary);
}

.summary-label {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.comparison-controls-bar {
  display: flex;
  gap: 8px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-light);
}

.view-toggle {
  padding: 8px 16px;
  border: 1px solid var(--border-medium);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 0.9rem;
  cursor: pointer;
  transition: all 0.2s;
}

.view-toggle:hover {
  background: var(--bg-tertiary);
}

.view-toggle.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.comparison-tree {
  padding: 16px 20px;
  max-height: 600px;
  overflow-y: auto;
}

.comparison-item {
  margin: 4px 0;
}

.item-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: default;
  transition: background 0.2s;
}

.item-row.folder {
  cursor: pointer;
}

.item-row:hover {
  background: var(--bg-tertiary);
}

.item-row.identical {
  opacity: 0.7;
}

.item-row.modified {
  background: rgba(201, 166, 84, 0.05);
}

.item-row.missing_from_target {
  background: rgba(84, 140, 201, 0.05);
}

.item-row.extra_in_target {
  background: rgba(199, 107, 107, 0.05);
}

.expand-icon {
  font-size: 0.7rem;
  transition: transform 0.2s;
  color: var(--text-muted);
  width: 12px;
}

.expand-icon.expanded {
  transform: rotate(90deg);
}

.item-icon {
  font-size: 1rem;
}

.item-name {
  flex: 1;
  color: var(--text-primary);
  font-size: 0.95rem;
}

.difference-badge {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(201, 166, 84, 0.2);
  color: #8a7230;
}

.item-status {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  font-size: 0.85rem;
  font-weight: bold;
}

.status-icon.identical {
  background: rgba(107, 158, 120, 0.2);
  color: var(--success);
}

.status-icon.modified {
  background: rgba(201, 166, 84, 0.2);
  color: #8a7230;
}

.status-icon.missing {
  background: rgba(84, 140, 201, 0.2);
  color: #4a7ab0;
}

.status-icon.extra {
  background: rgba(199, 107, 107, 0.2);
  color: var(--danger);
}

.item-details {
  margin-left: 52px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  font-size: 0.85rem;
}

.detail-row {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  color: var(--text-secondary);
}

.detail-label {
  color: var(--text-muted);
  min-width: 60px;
}

.detail-date {
  color: var(--text-muted);
  margin-left: auto;
}

.detail-row.only-source {
  color: #4a7ab0;
}

.detail-row.only-target {
  color: var(--danger);
}

.item-children {
  border-left: 1px solid var(--border-light);
  margin-left: 16px;
  padding-left: 8px;
}

.no-differences {
  text-align: center;
  padding: 40px;
  color: var(--success);
  font-size: 1.1rem;
}
```

**Step 3: Commit**

```bash
git add frontend/src/components/ComparisonResults.tsx frontend/src/components/ComparisonResults.css
git commit -m "feat(ui): create ComparisonResults component

- Collapsible tree view with status icons
- Summary bar showing identical/modified/missing/extra counts
- Toggle between differences-only and show-all views
- File details showing size and dates for both sides
- Save/Update comparison snapshot button"
```

---

## Task 7: Update SnapshotGallery for Comparison Snapshots

**Files:**
- Modify: `frontend/src/components/SnapshotGallery.tsx`
- Modify: `frontend/src/components/SnapshotGallery.css`

**Step 1: Update SnapshotGallery to handle comparison snapshots**

Update imports and props:

```typescript
import type { ComparisonSnapshot } from "../api";

interface SnapshotGalleryProps {
  snapshots: ComparisonSnapshot[];
  onSelectSnapshot: (snapshot: ComparisonSnapshot) => void;
  onDeleteSnapshot: (snapshotId: string) => void;
}
```

Update the card rendering to show comparison-specific info:

```typescript
export function SnapshotGallery({
  snapshots,
  onSelectSnapshot,
  onDeleteSnapshot,
}: SnapshotGalleryProps) {
  // ... existing code ...

  return (
    <div className="snapshot-gallery">
      <h3>Saved Snapshots</h3>
      <div className="snapshot-cards">
        {snapshots.filter(s => s && s.id).map((snapshot) => {
          const isComparison = snapshot.snapshotType === "comparison";

          return (
            <div
              key={snapshot.id}
              className={`snapshot-card ${isComparison ? "comparison" : ""}`}
              onClick={() => onSelectSnapshot(snapshot)}
            >
              <div className="snapshot-header">
                <div className="snapshot-type-icon">
                  {isComparison ? "📁↔📁" : "📁"}
                </div>
                <h4 className="snapshot-path">
                  {isComparison ? "Comparison" : snapshot.rootPath}
                </h4>
                <button
                  className="snapshot-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      window.confirm(
                        `Are you sure you want to delete this ${isComparison ? "comparison" : "snapshot"}?`
                      )
                    ) {
                      onDeleteSnapshot(snapshot.id);
                    }
                  }}
                  title="Delete snapshot"
                >
                  ×
                </button>
              </div>

              {isComparison ? (
                <div className="snapshot-paths">
                  <div className="comparison-path">
                    <span className="path-label">Source:</span>
                    <span className="path-value">{snapshot.rootPath}</span>
                  </div>
                  <div className="comparison-path">
                    <span className="path-label">Target:</span>
                    <span className="path-value">{snapshot.targetPath}</span>
                  </div>
                </div>
              ) : null}

              <div className="snapshot-info">
                {isComparison && snapshot.comparisonSummary ? (
                  <>
                    <div className="snapshot-stat">
                      <span className="stat-label">Identical:</span>
                      <span className="stat-value identical">
                        {snapshot.comparisonSummary.identical}
                      </span>
                    </div>
                    <div className="snapshot-stat">
                      <span className="stat-label">Differences:</span>
                      <span className="stat-value modified">
                        {snapshot.comparisonSummary.modified +
                          snapshot.comparisonSummary.missingFromTarget +
                          snapshot.comparisonSummary.extraInTarget}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="snapshot-stat">
                      <span className="stat-label">Files:</span>
                      <span className="stat-value">
                        {(snapshot.totalFiles || 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="snapshot-stat">
                      <span className="stat-label">Size:</span>
                      <span className="stat-value">
                        {formatBytes(snapshot.totalSizeBytes || 0)}
                      </span>
                    </div>
                    <div className="snapshot-stat">
                      <span className="stat-label">Findings:</span>
                      <span className="stat-value">{snapshot.findings?.length || 0}</span>
                    </div>
                  </>
                )}
              </div>

              <div className="snapshot-date">
                Saved {formatDate(snapshot.savedAt || new Date().toISOString())}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

**Step 2: Add CSS for comparison snapshots**

Add to `SnapshotGallery.css`:

```css
.snapshot-card.comparison {
  border-left: 3px solid var(--accent-primary);
}

.snapshot-type-icon {
  font-size: 1.2rem;
  margin-right: 8px;
}

.snapshot-header {
  display: flex;
  align-items: center;
}

.snapshot-paths {
  margin: 8px 0;
  padding: 8px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  font-size: 0.85rem;
}

.comparison-path {
  display: flex;
  gap: 8px;
  padding: 2px 0;
}

.comparison-path .path-label {
  color: var(--text-muted);
  min-width: 50px;
}

.comparison-path .path-value {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat-value.identical {
  color: var(--success);
}

.stat-value.modified {
  color: #8a7230;
}
```

**Step 3: Commit**

```bash
git add frontend/src/components/SnapshotGallery.tsx frontend/src/components/SnapshotGallery.css
git commit -m "feat(ui): update SnapshotGallery for comparison snapshots

- Show distinct icon for comparison snapshots
- Display source and target paths
- Show comparison summary (identical vs differences)
- Visual distinction with left border"
```

---

## Task 8: Wire Everything Together in App.tsx

**Files:**
- Modify: `frontend/src/App.tsx`

**Step 1: Add imports and state for comparison**

```typescript
import {
  getFindings,
  getExtensionSummary,
  healthCheck,
  saveSnapshot,
  getSnapshots,
  updateSnapshot,
  deleteSnapshot,
  saveComparisonSnapshot,
  updateComparisonSnapshot,
} from "./api";
import type {
  Finding,
  ScanResponse,
  ExtensionSummary as ExtSummaryType,
  ComparisonSnapshot,
  ComparisonResponse,
  ComparisonSummary,
  ComparisonItem,
} from "./api";
import { ComparisonResults } from "./components/ComparisonResults";
```

Add state:

```typescript
// Comparison state
const [comparisonResult, setComparisonResult] = useState<ComparisonResponse | null>(null);
const [comparisonSnapshot, setComparisonSnapshot] = useState<ComparisonSnapshot | null>(null);
```

**Step 2: Add comparison handlers**

```typescript
// Handle comparison completion
const handleComparisonComplete = (result: ComparisonResponse) => {
  setComparisonResult(result);
  setComparisonSnapshot(null);
  setScanId(null);  // Clear single-folder scan
  setScanInfo(null);
  setCurrentSnapshot(null);
};

// Handle saving comparison snapshot
const handleSaveComparisonSnapshot = async () => {
  if (!comparisonResult) return;

  setIsSavingSnapshot(true);
  try {
    const snapshot = await saveComparisonSnapshot(
      comparisonResult.sourcePath,
      comparisonResult.targetPath,
      comparisonResult.comparisonId
    );
    setSnapshots([snapshot, ...snapshots]);
    setComparisonSnapshot(snapshot);
    alert("Comparison snapshot saved successfully!");
  } catch (err) {
    console.error("Failed to save comparison snapshot:", err);
    alert("Failed to save comparison snapshot. Please try again.");
  } finally {
    setIsSavingSnapshot(false);
  }
};

// Handle updating comparison snapshot
const handleUpdateComparisonSnapshot = async () => {
  if (!comparisonSnapshot) return;

  setIsSavingSnapshot(true);
  try {
    const updated = await updateComparisonSnapshot(comparisonSnapshot.id);
    setSnapshots(snapshots.map(s => s.id === updated.id ? updated : s));
    setComparisonSnapshot(updated);
    alert("Comparison snapshot updated successfully!");
  } catch (err) {
    console.error("Failed to update comparison snapshot:", err);
    alert("Failed to update comparison snapshot. Please try again.");
  } finally {
    setIsSavingSnapshot(false);
  }
};

// Update handleSelectSnapshot to handle comparison snapshots
const handleSelectSnapshot = (snapshot: ComparisonSnapshot) => {
  if (snapshot.snapshotType === "comparison") {
    // Load comparison snapshot
    setComparisonSnapshot(snapshot);
    setComparisonResult({
      comparisonId: snapshot.scanId,
      sourcePath: snapshot.rootPath,
      targetPath: snapshot.targetPath || "",
      summary: snapshot.comparisonSummary || {
        identical: 0,
        modified: 0,
        missingFromTarget: 0,
        extraInTarget: 0,
        totalSourceSize: 0,
        totalTargetSize: 0,
      },
      tree: snapshot.comparison || [],
      deepScan: false,
      completedAt: snapshot.savedAt,
    });
    // Clear single-folder scan
    setScanId(null);
    setScanInfo(null);
    setCurrentSnapshot(null);
  } else {
    // Load regular scan snapshot
    setCurrentSnapshot(snapshot);
    setFindings(snapshot.findings);
    setExtensions(snapshot.extensions);
    setScanInfo(snapshot.scanInfo);
    setScanId(snapshot.scanId);
    // Clear comparison
    setComparisonResult(null);
    setComparisonSnapshot(null);
  }
  setActiveTab("findings");
};

// Update handleScanComplete to clear comparison state
const handleScanComplete = (newScanId: string, info: ScanResponse) => {
  setScanId(newScanId);
  setScanInfo(info);
  setCurrentSnapshot(null);
  // Clear comparison state
  setComparisonResult(null);
  setComparisonSnapshot(null);
};
```

**Step 3: Update ScanControls props**

```tsx
<ScanControls
  onScanComplete={handleScanComplete}
  onComparisonComplete={handleComparisonComplete}
  status={scanStatus}
  setStatus={setScanStatus}
  scanInfo={scanInfo}
/>
```

**Step 4: Add conditional rendering for ComparisonResults**

Replace the results section with:

```tsx
{comparisonResult && (
  <ComparisonResults
    sourcePath={comparisonResult.sourcePath}
    targetPath={comparisonResult.targetPath}
    summary={comparisonResult.summary}
    tree={comparisonResult.tree}
    isSnapshot={comparisonSnapshot !== null}
    onSaveSnapshot={handleSaveComparisonSnapshot}
    onUpdateSnapshot={handleUpdateComparisonSnapshot}
    isSaving={isSavingSnapshot}
  />
)}

{scanId && scanInfo && !comparisonResult && (
  <ScanResults
    activeTab={activeTab}
    setActiveTab={setActiveTab}
    findings={findings}
    extensions={extensions}
    categories={categories}
    selectedCategory={selectedCategory}
    setSelectedCategory={setSelectedCategory}
    searchQuery={searchQuery}
    setSearchQuery={setSearchQuery}
    loading={loading}
    filteredFindings={filteredFindings}
    scanId={scanId}
    rootPath={scanInfo.rootPath}
    isSnapshot={currentSnapshot !== null}
    snapshotId={currentSnapshot?.id}
    onSaveSnapshot={handleSaveSnapshot}
    onUpdateSnapshot={handleUpdateSnapshot}
    isSaving={isSavingSnapshot}
  />
)}
```

**Step 5: Update welcome message condition**

```tsx
{!scanId && !comparisonResult && scanStatus === "idle" && (
  <>
    <div className="welcome-message">
      {/* ... existing welcome content ... */}
    </div>

    <SnapshotGallery
      snapshots={snapshots}
      onSelectSnapshot={handleSelectSnapshot}
      onDeleteSnapshot={handleDeleteSnapshot}
    />
  </>
)}
```

**Step 6: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: wire up comparison feature in App.tsx

- Add comparison state management
- Handle comparison completion and snapshot loading
- Conditional rendering between ScanResults and ComparisonResults
- Update snapshot selection to handle both types"
```

---

## Task 9: Final Testing and Cleanup

**Step 1: Start backend**

```bash
cd backend
pip install -r requirements.txt
python main.py
```

**Step 2: Start frontend**

```bash
cd frontend
npm run dev
```

**Step 3: Manual test checklist**

1. [ ] Single folder scan still works
2. [ ] Toggle comparison mode shows second directory picker
3. [ ] Can select two directories and run comparison
4. [ ] Comparison results display correctly
5. [ ] Collapsing/expanding folders works
6. [ ] "Differences only" vs "Show all" toggle works
7. [ ] Save comparison snapshot works
8. [ ] Update comparison snapshot works
9. [ ] Snapshot gallery shows both types
10. [ ] Clicking comparison snapshot loads comparison view
11. [ ] Clicking scan snapshot loads scan view
12. [ ] Deep scan option works (slower but verifies hashes)

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete folder comparison feature

Adds the ability to compare two directories side-by-side:
- UI for selecting source and target directories
- Backend comparison logic with optional hash verification
- Collapsible tree view showing differences
- Comparison snapshots saveable alongside regular scans

Closes folder-comparison feature"
```

---

## Summary

This plan implements the folder comparison feature in 9 tasks:

1. **Database schema** - Add comparison fields
2. **FolderComparator class** - Core comparison logic
3. **API endpoints** - Comparison and snapshot endpoints
4. **Frontend API** - Types and functions
5. **ScanControls** - Add comparison mode UI
6. **ComparisonResults** - New component for results
7. **SnapshotGallery** - Support comparison snapshots
8. **App.tsx** - Wire everything together
9. **Testing** - Manual verification

Each task has specific files, code, and commit messages to keep changes organized and reviewable.
