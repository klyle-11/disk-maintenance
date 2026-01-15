# Folder Comparison Feature Design

**Date:** 2026-01-15
**Status:** Approved

## Overview

Add the ability to compare two directories side-by-side, identifying duplicates, differences, and missing files. Primary use cases:

1. **Mirror comparison** - Compare folders with the same name (e.g., `D:\Photos` vs `E:\Backup\Photos`) to validate sync status
2. **Backup validation** - Verify that everything from a source exists somewhere in a target backup location

## Use Cases

- Compare local drive directory against identical directory on external drive
- See what needs to be backed up
- Identify files that have been modified since last backup
- Detect silent corruption with optional deep scan

## UI Design

### ScanControls Changes

Add optional comparison mode with a second directory picker:

```
┌─────────────────────────────────────────────────────────────┐
│  Disk Intelligence                            [Ready]       │
├─────────────────────────────────────────────────────────────┤
│  [Select Directory]  D:\Photos                [Scan & Analyze]│
│                                                             │
│  ☐ Compare with another folder                              │
│                                                             │
│  (When checked, reveals:)                                   │
│  [Select Target]     E:\Backup\Photos         [Compare]     │
│  ☐ Deep scan (verify file contents)                         │
└─────────────────────────────────────────────────────────────┘
```

- Checkbox toggles comparison mode
- Second directory picker labeled "Target" (first becomes "Source")
- Action button changes to "Compare" when both paths are set
- Optional "Deep scan" checkbox for hash verification

### ComparisonResults Component

New component displaying side-by-side comparison as a collapsible tree:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Comparing: D:\Photos  ←→  E:\Backup\Photos                         │
│  ─────────────────────────────────────────────────────────────────  │
│  Summary: 1,247 identical │ 23 modified │ 8 missing │ 2 extra       │
│                                                                     │
│  [Show differences only ▼]  [Toggle: All items]                     │
├─────────────────────────────────────────────────────────────────────┤
│  ▶ 📁 Vacations (identical - 156 files, 2.3 GB)          [=]        │
│  ▼ 📁 2024 (3 differences)                               [≠]        │
│    │  ├─ beach.jpg     Modified: newer in source         [→]        │
│    │  │   Source: 2024-06-15, 4.2 MB                                │
│    │  │   Target: 2024-06-01, 4.2 MB                                │
│    │  ├─ sunset.png    Missing from target               [+]        │
│    │  │   Source: 2024-07-20, 8.1 MB                                │
│    │  └─ old.jpg       Only in target                    [−]        │
│  ▶ 📁 Family (identical - 89 files, 1.1 GB)              [=]        │
└─────────────────────────────────────────────────────────────────────┘
```

**Key elements:**
- Summary bar showing counts by status
- Collapsible tree structure - identical folders collapsed, different ones expanded by default
- Status icons:
  - `[=]` identical
  - `[≠]` has differences
  - `[+]` only in source (missing from target)
  - `[−]` only in target (extra)
  - `[→]` newer in source
  - `[←]` newer in target
- Expanded items show date/size details for both sides

### Snapshot Gallery Integration

Comparison snapshots displayed alongside regular scan snapshots:

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ 📁 D:\Photos    │  │ 📁↔📁 Compare   │  │ 📁 C:\Projects  │
│ 1,247 files     │  │ D:\Photos       │  │ 8,421 files     │
│ 45.2 GB         │  │ E:\Backup\Photos│  │ 12.1 GB         │
│ 12 findings     │  │ 23 differences  │  │ 34 findings     │
│ Jan 14, 2026    │  │ Jan 15, 2026    │  │ Jan 10, 2026    │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

- Comparison snapshots show distinct icon (`📁↔📁`) and both paths
- Clicking loads `ComparisonResults` instead of `ScanResults`
- "Update" re-runs comparison between same two paths

## Backend Design

### Comparison Algorithm

1. **Scan both directories** - Run `DiskScanner` on source and target (can run in parallel)
2. **Build file indexes** - Create dictionaries keyed by relative path from each root
3. **Match and compare**:
   - Files in source but not target → `missing_from_target`
   - Files in target but not source → `extra_in_target`
   - Files in both → compare size and date:
     - Same size + same date → `identical`
     - Same size + different date → `modified` (note which is newer)
     - Different size → `modified`
4. **Optional deep scan** - For files marked `identical` or `modified`, compute MD5/SHA256 hash to verify actual content match
5. **Aggregate folder status** - A folder is `identical` only if all its contents (recursive) are identical

### Difference Detection

Default (fast): Size + modified date comparison
Optional deep scan: SHA256 hash verification for precise content comparison

### New API Endpoints

```
POST /api/compare
Request:
{
  "source_path": "D:\\Photos",
  "target_path": "E:\\Backup\\Photos",
  "deep_scan": false
}

Response:
{
  "comparison_id": "...",
  "source_path": "...",
  "target_path": "...",
  "summary": {
    "identical": 1247,
    "modified": 23,
    "missing_from_target": 8,
    "extra_in_target": 2
  },
  "tree": [ /* nested comparison items */ ]
}

POST /api/snapshots/comparison - Save a comparison snapshot
PUT /api/snapshots/comparison/{id} - Re-run comparison and update
```

### Database Schema Changes

Extend `SnapshotDB` to support comparison snapshots:

```python
class SnapshotDB(Base):
    # Existing fields...
    id, scan_id, root_path, findings_json, extensions_json, ...

    # New fields for comparison snapshots:
    snapshot_type = Column(String, default="scan")  # "scan" or "comparison"
    target_path = Column(String, nullable=True)  # Only for comparisons
    comparison_json = Column(Text, nullable=True)  # Comparison tree data
    comparison_summary_json = Column(Text, nullable=True)  # Summary counts
```

## Files to Create/Modify

### Frontend (New)
- `components/ComparisonResults.tsx` - Side-by-side tree view component
- `components/ComparisonResults.css` - Styling for comparison UI

### Frontend (Modify)
- `components/ScanControls.tsx` - Add comparison mode toggle and second directory picker
- `components/ScanControls.css` - Styles for comparison controls
- `components/SnapshotGallery.tsx` - Display comparison snapshots with distinct styling
- `api.ts` - Add comparison API functions
- `App.tsx` - Add comparison state and conditional rendering

### Backend (Modify)
- `main.py` - Add `FolderComparator` class and comparison endpoints
- `database.py` - Extend `SnapshotDB` model with comparison fields

## Data Flow

```
User selects two folders
        ↓
POST /api/compare (with optional deep_scan flag)
        ↓
Backend: DiskScanner runs on both paths (parallel)
        ↓
Backend: FolderComparator builds tree with status for each item
        ↓
Frontend: ComparisonResults renders collapsible tree
        ↓
User clicks "Save Comparison Snapshot"
        ↓
POST /api/snapshots/comparison
        ↓
SnapshotGallery shows both scan and comparison snapshots
```

## State Changes in App.tsx

```typescript
// New state
const [comparisonMode, setComparisonMode] = useState(false);
const [comparisonResult, setComparisonResult] = useState<ComparisonResult | null>(null);
const [currentComparisonSnapshot, setCurrentComparisonSnapshot] = useState<Snapshot | null>(null);
```

App conditionally renders `ScanResults` or `ComparisonResults` based on what's loaded.

## Future Enhancements

- **Copy recommendations** - Show what needs to be copied and which direction, helping users decide what to sync (user executes outside the app)
- **Selective sync actions** - Actually copy files to sync folders
- **Scheduled comparisons** - Automatically re-run comparisons on a schedule
- **Comparison history** - Track how differences change over time

## Design Decisions

1. **View-only for MVP** - No sync/copy actions, keeps tool read-only and safe
2. **Size + date default** - Fast comparison suitable for most backup validation
3. **Optional deep scan** - Hash verification available when precision matters
4. **Difference-focused view** - Hide identical items by default, toggle to show all
5. **Collapsible tree** - Identical folders collapsed, different ones expanded for quick navigation
