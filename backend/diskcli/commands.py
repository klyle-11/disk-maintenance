"""Command implementations for the `di` CLI."""

from __future__ import annotations

import json
import os
import sys
import time

from . import maint
from . import picker
from . import render as r
from . import store
from .walker import ScanError, cloud_hint, find_recent_files, scan, DEFAULT_EXCLUDES

# Folder names that are regenerable: safe-ish to delete, and usually the
# reason a project directory is enormous.
REGENERABLE = {
    "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", "target", "build", "dist", ".next", ".nuxt", ".turbo",
    ".parcel-cache", ".gradle", "DerivedData", "Pods", ".tox", ".cargo",
    "vendor", "bower_components", ".terraform", ".sass-cache", "coverage",
}

CACHE_HINTS = ("cache", "Cache", "Caches", "tmp", "temp", "Temp", "logs", "Logs")

ARCHIVE_EXTS = {".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".dmg", ".iso", ".pkg"}
MEDIA_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".wav", ".aiff", ".psd", ".ai", ".sketch", ".fig"}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _scan_with_progress(path: str, depth: int, days: float, quiet: bool):
    spinner = r.Spinner(f"scanning {r.truncate_path(path, 50)}")

    def progress(done, total, current):
        if not quiet:
            spinner.tick(f"{done}/{total}  {r.truncate_path(current, 40)}")

    try:
        result = scan(path, max_depth=depth, recent_days=days, on_progress=progress)
    except ScanError as exc:
        r.error(str(exc))
        raise SystemExit(2)

    if not quiet:
        spinner.done(
            f"scanned {r.human_count(result.total_files)} files in {result.elapsed:.1f}s"
            + (f" ({result.errors} unreadable)" if result.errors else "")
        )
    return result


def _resolve(path: str) -> str:
    return os.path.abspath(os.path.expanduser(path))


def _rows_for_depth(result, depth: int, top: int, min_bytes: int):
    rows = [n for n in result.nodes.values() if n.depth == depth and n.size >= min_bytes]
    rows.sort(key=lambda n: n.size, reverse=True)
    return rows[:top]


def _print_table(rows, total: int, root: str, show_recent: bool, days: float):
    if not rows:
        r.note("nothing above the size threshold")
        return

    width = min(r.term_width(), 120)
    recent_col = 10 if show_recent else 0
    path_width = max(20, width - 10 - 20 - 7 - recent_col - 8 - 10 - 6)

    head = f"  {'SIZE':>9}  {'':20} {'SHARE':>6}"
    if show_recent:
        head += f"  {f'NEW/{int(days)}d':>9}"
    head += f"  {'FILES':>7}  {'TOUCHED':>9}  FOLDER"
    print(f"{r.DIM}{head}{r.RESET}")

    for node in rows:
        share = node.size / total if total else 0
        color = r.heat_color(share)
        line = f"  {r.human_size(node.size):>9}  {r.bar(share, 20, color)} {share * 100:5.1f}%"
        if show_recent:
            if node.recent_bytes:
                recent = f"{r.RED}{r.human_size(node.recent_bytes):>9}{r.RESET}"
            else:
                recent = f"{r.DIM}{'—':>9}{r.RESET}"
            line += f"  {recent}"
        line += f"  {r.human_count(node.files):>7}"
        line += f"  {r.DIM}{r.human_age(node.newest_mtime):>9}{r.RESET}"
        line += f"  {r.truncate_path(node.path, path_width, root)}"
        if node.cloud:
            line += f"  {r.CYAN}☁ {node.cloud}{r.RESET}"
        print(line)


def _cloud_tops(result) -> list:
    """Outermost scanned folders inside a cloud sync folder."""
    def outermost(n) -> bool:
        parent = result.nodes.get(os.path.dirname(n.path)) if n.path != result.root else None
        return parent is None or not parent.cloud

    return sorted((n for n in result.nodes.values() if n.cloud and n.cloud_bytes and outermost(n)),
                  key=lambda n: -n.cloud_bytes)


def _print_cloud_note(result) -> None:
    tops = _cloud_tops(result)
    if not tops:
        return
    total = sum(n.cloud_bytes for n in tops)
    providers = sorted({n.cloud for n in tops})
    print()
    print(f"  {r.CYAN}☁{r.RESET} {r.BOLD}{r.human_size(total)}{r.RESET} are downloaded cloud files "
          f"({', '.join(providers)}) {r.DIM}— still in the cloud, so the provider can free them here:{r.RESET}")
    for p in providers:
        r.note(f"    {p}: {cloud_hint(p)}")
    r.note("    cloud-only files are not counted in any size above")


def _tag_folder(name: str) -> str | None:
    """Label a folder as regenerable/cache when the name gives it away."""
    if name in REGENERABLE:
        return "regenerable"
    lowered = name.lower()
    if any(hint.lower() == lowered for hint in CACHE_HINTS):
        return "cache"
    return None


# ---------------------------------------------------------------------------
# di scan
# ---------------------------------------------------------------------------

def cmd_scan(args) -> int:
    root = _resolve(args.path)
    result = _scan_with_progress(root, args.depth, args.days, args.json)

    if args.json:
        payload = {
            "root": result.root,
            "total_bytes": result.total_size,
            "total_files": result.total_files,
            "elapsed_seconds": round(result.elapsed, 2),
            "unreadable": result.errors,
            "entries": [
                {
                    "path": n.path,
                    "depth": n.depth,
                    "bytes": n.size,
                    "files": n.files,
                    "recent_bytes": n.recent_bytes,
                    "newest_mtime": n.newest_mtime,
                    "cloud": n.cloud,
                    "cloud_bytes": n.cloud_bytes,
                }
                for n in sorted(result.nodes.values(), key=lambda n: -n.size)
                if n.depth <= args.depth and n.size >= args.min_bytes
            ],
        }
        print(json.dumps(payload, indent=2))
        return 0

    print()
    print(r.header(
        r.truncate_path(root, 70),
        f"{r.human_size(result.total_size)} · {r.human_count(result.total_files)} files · {result.elapsed:.1f}s",
    ))
    print(r.rule())

    for depth in range(1, args.depth + 1):
        rows = _rows_for_depth(result, depth, args.top, args.min_bytes)
        if not rows:
            continue
        if args.depth > 1:
            print(f"\n{r.BOLD}depth {depth}{r.RESET}")
        _print_table(rows, result.total_size, root, True, args.days)

    _print_cloud_note(result)

    if result.errors:
        print()
        r.note(f"{result.errors} paths were unreadable (permissions) and were skipped")

    if args.save:
        conn = store.connect(args.db)
        baseline_id = store.save_baseline(
            conn, root, args.depth, result.total_size, result.total_files,
            store.entries_from_scan(result, root), args.label,
        )
        print()
        r.note(f"baseline saved as {baseline_id} — compare later with:  di growth {args.path}")
    return 0


# ---------------------------------------------------------------------------
# di recent
# ---------------------------------------------------------------------------

def cmd_recent(args) -> int:
    """
    What has recently been taking up space. Answers the question without
    needing any prior baseline: it ranks folders by bytes written inside the
    window, then lists the individual files responsible.
    """
    root = _resolve(args.path)
    result = _scan_with_progress(root, args.depth, args.days, args.json)

    # depth 0 is the root itself, which is always 100% of itself.
    rows = [
        n for n in result.nodes.values()
        if 1 <= n.depth <= args.depth and n.recent_bytes >= args.min_bytes
    ]
    rows.sort(key=lambda n: n.recent_bytes, reverse=True)

    # Keep the deepest meaningful attribution: drop a parent when a single
    # child accounts for essentially all of its recent bytes.
    filtered = []
    for node in rows:
        dominated = any(
            other.path != node.path
            and other.path.startswith(node.path + os.sep)
            and other.recent_bytes >= node.recent_bytes * 0.9
            for other in rows
        )
        if not dominated:
            filtered.append(node)
    rows = filtered[: args.top]

    total_recent = result.nodes[root].recent_bytes

    if args.json:
        files = find_recent_files(root, args.days, args.files, args.min_bytes)
        print(json.dumps({
            "root": root,
            "window_days": args.days,
            "recent_bytes": total_recent,
            "recent_files": result.nodes[root].recent_files,
            "folders": [
                {"path": n.path, "recent_bytes": n.recent_bytes,
                 "recent_files": n.recent_files, "total_bytes": n.size}
                for n in rows
            ],
            "files": files,
        }, indent=2))
        return 0

    print()
    print(r.header(
        f"Recent growth · last {int(args.days)} days",
        r.truncate_path(root, 50),
    ))
    print(r.rule())
    print(f"  {r.BOLD}{r.human_size(total_recent)}{r.RESET} written or modified in the window "
          f"{r.DIM}({r.human_count(result.nodes[root].recent_files)} files, "
          f"{total_recent / result.total_size * 100 if result.total_size else 0:.1f}% of the tree){r.RESET}")

    if not rows:
        print()
        r.note(f"no folder gained more than {r.human_size(args.min_bytes)} in this window")
        return 0

    print()
    width = min(r.term_width(), 120)
    path_width = max(20, width - 62)
    print(f"{r.DIM}  {'NEW':>9}  {'':20} {'SHARE':>6}  {'OF FOLDER':>9}  {'FILES':>7}  FOLDER{r.RESET}")

    for node in rows:
        share = node.recent_bytes / total_recent if total_recent else 0
        of_folder = node.recent_bytes / node.size if node.size else 0
        color = r.heat_color(share)
        tag = _tag_folder(os.path.basename(node.path))
        label = r.truncate_path(node.path, path_width, root)
        if tag:
            label += f" {r.DIM}[{tag}]{r.RESET}"
        print(
            f"  {r.RED}{r.human_size(node.recent_bytes):>9}{r.RESET}"
            f"  {r.bar(share, 20, color)} {share * 100:5.1f}%"
            f"  {of_folder * 100:8.0f}%"
            f"  {r.human_count(node.recent_files):>7}"
            f"  {label}"
        )

    if args.files:
        files = find_recent_files(root, args.days, args.files, max(args.min_bytes, 1 << 20))
        if files:
            print()
            print(f"{r.BOLD}Largest individual files in the window{r.RESET}")
            print()
            print(f"{r.DIM}  {'SIZE':>9}  {'MODIFIED':>10}  FILE{r.RESET}")
            for f in files:
                ext = os.path.splitext(f["path"])[1].lower()
                mark = ""
                if ext in ARCHIVE_EXTS:
                    mark = f" {r.DIM}[archive]{r.RESET}"
                elif ext in MEDIA_EXTS:
                    mark = f" {r.DIM}[media]{r.RESET}"
                print(
                    f"  {r.human_size(f['size']):>9}"
                    f"  {r.DIM}{r.human_age(f['mtime']):>10}{r.RESET}"
                    f"  {r.truncate_path(f['path'], path_width + 10, root)}{mark}"
                )

    print()
    r.note(f"tip: save a baseline now with  di snapshot {args.path}  then use  di growth {args.path}  later")
    return 0


# ---------------------------------------------------------------------------
# di growth
# ---------------------------------------------------------------------------

def cmd_growth(args) -> int:
    """Diff the current tree against a stored baseline."""
    root = _resolve(args.path)
    conn = store.connect(args.db)

    if args.baseline:
        base = store.get_baseline(conn, args.baseline)
        if not base:
            r.error(f"no baseline with id {args.baseline}")
            return 2
    else:
        base = store.latest_baseline(conn, root)
        if not base:
            r.error(f"no baseline recorded for {root}")
            print(f"\n  Take one now:  {r.BOLD}di snapshot {args.path}{r.RESET}", file=sys.stderr)
            print(f"  Meanwhile:     {r.BOLD}di recent {args.path}{r.RESET}  "
                  f"{r.DIM}(needs no baseline){r.RESET}", file=sys.stderr)
            return 1

    depth = args.depth or base["depth"]
    result = _scan_with_progress(root, depth, args.days, args.json)

    old_entries = json.loads(base["entries_json"])
    new_entries = store.entries_from_scan(result, root)

    deltas = []
    for rel, new in new_entries.items():
        old = old_entries.get(rel)
        old_size = old["size"] if old else 0
        delta = new["size"] - old_size
        if abs(delta) < args.min_bytes:
            continue
        deltas.append({
            "rel": rel,
            "path": os.path.join(root, rel) if rel != "." else root,
            "old": old_size,
            "new": new["size"],
            "delta": delta,
            "is_new": old is None,
            "depth": 0 if rel == "." else rel.count(os.sep) + 1,
        })

    # Folders that disappeared entirely.
    for rel, old in old_entries.items():
        if rel not in new_entries and old["size"] >= args.min_bytes:
            deltas.append({
                "rel": rel,
                "path": os.path.join(root, rel) if rel != "." else root,
                "old": old["size"],
                "new": 0,
                "delta": -old["size"],
                "is_new": False,
                "gone": True,
                "depth": 0 if rel == "." else rel.count(os.sep) + 1,
            })

    # Files sitting directly in the scan root belong to no subfolder row, so
    # give them one of their own. own_size is disjoint from every child
    # subtree, so this never double-counts.
    root_own_old = old_entries.get(".", {}).get("own", 0)
    root_own_new = result.nodes[root].own_size
    if abs(root_own_new - root_own_old) >= args.min_bytes:
        deltas.append({
            "rel": ".",
            "path": root,
            "old": root_own_old,
            "new": root_own_new,
            "delta": root_own_new - root_own_old,
            "is_new": False,
            "loose": True,
            "depth": 1,
        })

    total_delta = result.total_size - base["total_bytes"]
    elapsed_days = (time.time() - base["taken_ts"]) / 86400

    if args.json:
        print(json.dumps({
            "root": root,
            "baseline_id": base["id"],
            "baseline_taken_at": base["taken_at"],
            "days_elapsed": round(elapsed_days, 2),
            "old_bytes": base["total_bytes"],
            "new_bytes": result.total_size,
            "delta_bytes": total_delta,
            "changes": sorted(deltas, key=lambda d: -abs(d["delta"])),
        }, indent=2))
        return 0

    grew = sorted([d for d in deltas if d["delta"] > 0 and d["depth"] > 0],
                  key=lambda d: -d["delta"])[: args.top]
    shrank = sorted([d for d in deltas if d["delta"] < 0 and d["depth"] > 0],
                    key=lambda d: d["delta"])[: args.top]

    print()
    print(r.header(
        f"Growth since {base['taken_at'][:16].replace('T', ' ')}",
        f"{elapsed_days:.1f} days · baseline {base['id']}"
        + (f" · {base['label']}" if base["label"] else ""),
    ))
    print(r.rule())
    color = r.delta_color(total_delta)
    rate = total_delta / elapsed_days if elapsed_days >= 0.5 else 0
    print(
        f"  {r.human_size(base['total_bytes']):>10}"
        f"  {r.DIM}→{r.RESET}  {r.human_size(result.total_size):>10}"
        f"   {color}{r.BOLD}{r.human_size(total_delta, signed=True)}{r.RESET}"
        + (f"   {r.DIM}({r.human_size(rate, signed=True)}/day){r.RESET}" if rate else "")
    )

    biggest = max((abs(d["delta"]) for d in deltas if d["depth"] > 0), default=1)
    width = min(r.term_width(), 120)
    path_width = max(20, width - 58)

    def show(title: str, items: list, color: str) -> None:
        if not items:
            return
        print()
        print(f"{r.BOLD}{title}{r.RESET}")
        print()
        print(f"{r.DIM}  {'CHANGE':>10}  {'':20}  {'WAS':>9}  {'NOW':>9}  FOLDER{r.RESET}")
        for d in items:
            frac = abs(d["delta"]) / biggest
            marker = ""
            if d.get("loose"):
                marker = f" {r.DIM}[loose files in root]{r.RESET}"
            elif d.get("is_new"):
                marker = f" {r.DIM}[new]{r.RESET}"
            elif d.get("gone"):
                marker = f" {r.DIM}[removed]{r.RESET}"
            tag = _tag_folder(os.path.basename(d["path"]))
            if tag:
                marker += f" {r.DIM}[{tag}]{r.RESET}"
            print(
                f"  {color}{r.human_size(d['delta'], signed=True):>10}{r.RESET}"
                f"  {r.bar(frac, 20, color)}"
                f"  {r.DIM}{r.human_size(d['old']):>9}{r.RESET}"
                f"  {r.human_size(d['new']):>9}"
                f"  {r.truncate_path(d['path'], path_width, root)}{marker}"
            )

    show(f"Grew the most", grew, r.RED)
    show(f"Shrank the most", shrank, r.GREEN)

    if not grew and not shrank:
        print()
        r.note(f"no folder changed by more than {r.human_size(args.min_bytes)}")

    if args.save:
        baseline_id = store.save_baseline(
            conn, root, depth, result.total_size, result.total_files,
            new_entries, args.label,
        )
        print()
        r.note(f"new baseline saved as {baseline_id}")
    return 0


# ---------------------------------------------------------------------------
# di snapshot / snapshots / forget
# ---------------------------------------------------------------------------

def cmd_snapshot(args) -> int:
    root = _resolve(args.path)
    result = _scan_with_progress(root, args.depth, 30.0, args.json)
    conn = store.connect(args.db)
    baseline_id = store.save_baseline(
        conn, root, args.depth, result.total_size, result.total_files,
        store.entries_from_scan(result, root), args.label,
    )
    if args.keep:
        removed = store.prune_baselines(conn, root, args.keep)
        if removed:
            r.note(f"pruned {removed} older baseline(s)")

    if args.json:
        print(json.dumps({
            "baseline_id": baseline_id, "root": root,
            "total_bytes": result.total_size, "total_files": result.total_files,
        }, indent=2))
        return 0

    print()
    print(f"  {r.GREEN}✓{r.RESET} baseline {r.BOLD}{baseline_id}{r.RESET} — "
          f"{r.human_size(result.total_size)} across {r.human_count(result.total_files)} files")
    print(f"    {r.DIM}compare later:  di growth {args.path}{r.RESET}")
    return 0


def cmd_snapshots(args) -> int:
    conn = store.connect(args.db)
    root = _resolve(args.path) if args.path else None
    rows = store.list_baselines(conn, root, args.limit)

    if args.json:
        print(json.dumps([dict(row) for row in rows], indent=2))
        return 0

    if not rows:
        r.note("no baselines recorded yet — take one with  di snapshot <path>")
        return 0

    print()
    print(f"{r.DIM}  {'ID':<13} {'TAKEN':<17} {'SIZE':>10}  {'FILES':>7}  PATH{r.RESET}")
    prev_by_root: dict[str, int] = {}
    for row in rows:
        delta = ""
        if row["root_path"] in prev_by_root:
            d = prev_by_root[row["root_path"]] - row["total_bytes"]
            if d:
                delta = f"  {r.delta_color(d)}{r.human_size(d, signed=True)}{r.RESET}"
        prev_by_root[row["root_path"]] = row["total_bytes"]
        label = f" {r.DIM}({row['label']}){r.RESET}" if row["label"] else ""
        print(
            f"  {r.BOLD}{row['id']:<13}{r.RESET}"
            f"{r.DIM}{row['taken_at'][:16].replace('T', ' '):<17}{r.RESET}"
            f"{r.human_size(row['total_bytes']):>10}"
            f"  {r.human_count(row['total_files']):>7}"
            f"  {r.truncate_path(row['root_path'], 40)}{label}{delta}"
        )
    print()
    r.note(f"database: {args.db or store.default_db_path()}")
    return 0


def cmd_forget(args) -> int:
    conn = store.connect(args.db)
    if store.delete_baseline(conn, args.id):
        print(f"  {r.GREEN}✓{r.RESET} removed baseline {args.id}")
        return 0
    r.error(f"no baseline with id {args.id}")
    return 1


# ---------------------------------------------------------------------------
# di reclaim
# ---------------------------------------------------------------------------

def cmd_reclaim(args) -> int:
    """Rank regenerable and cache folders by how much they'd give back."""
    root = _resolve(args.path)
    result = _scan_with_progress(root, args.depth, args.days, args.json)

    candidates = []
    for node in result.nodes.values():
        name = os.path.basename(node.path)
        tag = _tag_folder(name)
        # Deleting inside a cloud folder deletes it from the cloud too; reported separately.
        if not tag or node.size < args.min_bytes or node.cloud:
            continue
        # Skip a nested match inside an already-matched parent: deleting the
        # outer folder subsumes it.
        candidates.append({
            "path": node.path, "size": node.size, "files": node.files,
            "tag": tag, "newest_mtime": node.newest_mtime,
            "recent_bytes": node.recent_bytes,
        })

    tops = []
    for c in sorted(candidates, key=lambda c: -c["size"]):
        if any(c["path"].startswith(t["path"] + os.sep) for t in tops):
            continue
        tops.append(c)
    tops = tops[: args.top]
    reclaimable = sum(c["size"] for c in tops)

    if args.json:
        print(json.dumps({
            "root": root, "reclaimable_bytes": reclaimable, "candidates": tops
        }, indent=2))
        return 0

    print()
    print(r.header("Reclaimable space", r.truncate_path(root, 50)))
    print(r.rule())
    if not tops:
        r.note("no regenerable or cache folders above the threshold")
        _print_cloud_note(result)
        return 0

    print(f"  {r.BOLD}{r.human_size(reclaimable)}{r.RESET} in regenerable folders "
          f"{r.DIM}(rebuildable — but verify before deleting){r.RESET}")
    print()
    width = min(r.term_width(), 120)
    path_width = max(20, width - 61)
    print(f"{r.DIM}  {'#':>3}  {'SIZE':>9}  {'':20}  {'KIND':<12} {'TOUCHED':>9}  FOLDER{r.RESET}")
    for i, c in enumerate(tops, 1):
        frac = c["size"] / reclaimable if reclaimable else 0
        print(
            f"  {r.BOLD}{i:>3}{r.RESET}"
            f"  {r.human_size(c['size']):>9}"
            f"  {r.bar(frac, 20, r.heat_color(frac))}"
            f"  {r.CYAN}{c['tag']:<12}{r.RESET}"
            f"{r.DIM}{r.human_age(c['newest_mtime']):>9}{r.RESET}"
            f"  {r.truncate_path(c['path'], path_width, root)}"
        )
    _print_cloud_note(result)
    if not picker.interactive():
        print()
        r.note("nothing deleted — run in a terminal to pick folders to delete by number")
        return 0
    # Matched by folder name only, so every deletion asks y/N first.
    picker.delete_loop([
        picker.Choice(r.truncate_path(c["path"], 60), c["size"],
                      lambda p=c["path"]: _delete_reclaimable(p, root), confirm=True)
        for c in tops
    ], root)
    return 0


def _delete_reclaimable(path: str, root: str) -> None:
    real = os.path.realpath(path)
    if not maint._within(path, root) or real in (os.path.realpath(root), os.path.realpath(maint.HOME)):
        raise OSError(f"refusing to delete {path}")
    if not maint.remove_tree(path):
        raise OSError("partly deleted: some files are in use or access was denied")
