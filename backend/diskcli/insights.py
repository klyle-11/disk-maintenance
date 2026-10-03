"""
`di <path>` / `di insights <path>`: everything worth knowing about one folder.

The CLI take on the desktop app's findings, from a single walk:
    - biggest folders, and the biggest files written lately (what `di recent` shows)
    - dev junk that rebuilds itself (numbered: type its number to delete it)
    - caches, temp and log folders       (numbered, asks y/N first)
    - duplicate files (same size and content, renamed copies too)
    - duplicate folders (same name, size within 10%)
    - large folders untouched for a year
    - which file types take the space
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from collections import defaultdict

from . import commands
from . import maint
from . import picker
from . import render as r

MB = 1 << 20
GB = 1 << 30
DUP_FILE_MIN = 1 * MB
DUP_FOLDER_MIN = 10 * MB
OLD_FOLDER_MIN = 1 * GB
OLD_DAYS = 365
SAMPLE = 64 * 1024
FULL_HASH_MAX = 16 * MB
SHOW = 8  # rows per section


def _sample_hash(path: str, size: int) -> str | None:
    """
    Content hash for files that already share a size: the whole file up to
    FULL_HASH_MAX, beyond that the first, middle and last 64 KB.
    """
    h = hashlib.blake2b(digest_size=16)
    try:
        with open(path, "rb") as f:
            if size <= FULL_HASH_MAX:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            else:
                for offset in (0, size // 2, size - SAMPLE):
                    f.seek(offset)
                    h.update(f.read(SAMPLE))
    except OSError:
        return None
    return h.hexdigest()


def _inside(path: str, parents) -> bool:
    return any(path.startswith(p + os.sep) or path == p for p in parents)


def _junk_paths(result) -> set[str]:
    """Folders the junk and cache sections cover; duplicates inside them are noise."""
    return {n.path for n in result.nodes.values()
            if os.path.basename(n.path) in commands.REGENERABLE or commands._tag_folder(os.path.basename(n.path))}


def _duplicate_files(files_by_size: dict[int, list[str]], skip: set[str]) -> list[dict]:
    groups = []
    for size, paths in files_by_size.items():
        paths = [p for p in paths if not _inside(p, skip)]
        if len(paths) < 2:
            continue
        by_hash: dict[str, list[str]] = defaultdict(list)
        for p in paths:
            digest = _sample_hash(p, size)
            if digest:
                by_hash[digest].append(p)
        for same in by_hash.values():
            if len(same) >= 2:
                groups.append({"size": size, "paths": sorted(same), "reclaimable": size * (len(same) - 1)})
    groups.sort(key=lambda g: -g["reclaimable"])
    return groups


def _duplicate_folders(result, skip: set[str]) -> list[dict]:
    by_name: dict[str, list] = defaultdict(list)
    for n in result.nodes.values():
        name = os.path.basename(n.path).lower()
        if n.path != result.root and n.size >= DUP_FOLDER_MIN and not _inside(n.path, skip):
            by_name[name].append(n)
    groups = []
    for name, nodes in by_name.items():
        nodes.sort(key=lambda n: -n.size)
        clusters: list[list] = []
        for n in nodes:
            for c in clusters:
                if abs(n.size - c[0].size) <= 0.10 * c[0].size:
                    c.append(n)
                    break
            else:
                clusters.append([n])
        for c in clusters:
            paths = [n.path for n in c]
            # Nested copies (a/x inside b/x) are one folder, not two.
            if len(c) >= 2 and not any(_inside(p, [q]) for p in paths for q in paths if p != q):
                groups.append({"name": os.path.basename(c[0].path), "paths": paths,
                               "size": c[0].size, "reclaimable": sum(n.size for n in c[1:])})
    groups.sort(key=lambda g: -g["reclaimable"])
    # Drop groups already explained by a duplicated parent folder.
    shown: list[str] = []
    out = []
    for g in groups:
        if all(_inside(p, shown) for p in g["paths"]):
            continue
        shown += g["paths"]
        out.append(g)
    return out


def _old_folders(result) -> list:
    cutoff = time.time() - OLD_DAYS * 86400
    old = [n for n in result.nodes.values()
           if n.path != result.root and n.size >= OLD_FOLDER_MIN and 0 < n.newest_mtime < cutoff]
    old.sort(key=lambda n: -n.size)
    out = []
    for n in old:
        if not _inside(n.path, [o.path for o in out]):
            out.append(n)
    return out


def _section(title: str, total: int | None = None, hint: str = "") -> None:
    print()
    line = f"{r.BOLD}{title}{r.RESET}"
    if total is not None:
        line += f"  {r.human_size(total)}"
    if hint:
        line += f"  {r.DIM}{hint}{r.RESET}"
    print(line)


def _more(count: int, shown: int = SHOW) -> None:
    if count > shown:
        r.note(f"  … and {count - shown} more")


def cmd_insights(args) -> int:
    root = commands._resolve(args.path)
    files_by_size: dict[int, list[str]] = defaultdict(list)
    ext_bytes: dict[str, int] = defaultdict(int)
    recent: list[tuple[str, int, float]] = []
    cutoff = time.time() - args.days * 86400
    lock = threading.Lock()  # the walker calls on_file from several threads

    def on_file(path: str, size: int, _mtime: float) -> None:
        ext = os.path.splitext(path)[1].lower() or "(none)"
        with lock:
            ext_bytes[ext] += size
            if size >= DUP_FILE_MIN:
                files_by_size[size].append(path)
                if _mtime >= cutoff:
                    recent.append((path, size, _mtime))

    spinner = r.Spinner(f"scanning {r.truncate_path(root, 50)}")
    try:
        result = commands.scan(root, max_depth=args.depth, recent_days=args.days, on_file=on_file,
                               on_progress=lambda d, t, cur: spinner.tick(f"{d}/{t}  {r.truncate_path(cur, 40)}"))
    except commands.ScanError as exc:
        spinner.done()
        r.error(str(exc))
        return 2

    spinner.tick("dev junk")
    junk = maint.find_project_junk(root, maint.ALL_GROUPS)
    for j in junk:
        node = result.nodes.get(j.path)
        j.size = node.size if node else maint.disk_bytes(j.path)[0]
    junk = sorted((j for j in junk if j.size >= args.min_bytes), key=lambda j: -j.size)
    junk_set = {j.path for j in junk}

    caches = []
    for n in sorted(result.nodes.values(), key=lambda n: -n.size):
        name = os.path.basename(n.path)
        if (n.path == root or n.cloud or n.size < args.min_bytes or name in maint.PROJECT_JUNK
                or not commands._tag_folder(name) or _inside(n.path, junk_set)
                or _inside(n.path, [c.path for c in caches])):
            continue
        caches.append(n)

    spinner.tick("duplicates")
    skip = _junk_paths(result) | junk_set
    dup_files = _duplicate_files(files_by_size, skip)
    dup_folders = _duplicate_folders(result, skip)
    old = _old_folders(result)
    spinner.done()

    # ---- report
    print()
    print(r.header(r.full_path(root),
                   f"{r.human_size(result.total_size)} · {r.human_count(result.total_files)} files · {result.elapsed:.1f}s"))
    print(r.rule())

    rows = commands._rows_for_depth(result, 1, SHOW, 0)
    if rows:
        _section("Biggest folders")
        commands._print_table(rows, result.total_size, root, True, args.days)

    new_bytes = result.nodes[root].recent_bytes
    new_files = sorted((f for f in recent if not _inside(f[0], skip)), key=lambda f: -f[1])
    if new_files:
        _section(f"New in the last {args.days:g} days", new_bytes, "biggest files written lately")
        for path, size, mtime in new_files[:SHOW]:
            print(f"  {r.human_size(size):>9}  {r.DIM}{r.human_age(mtime):>9}{r.RESET}  "
                  f"{r.truncate_path(path, max(20, min(r.term_width(), 120) - 30), root)}")
        _more(len(new_files))

    choices: list[picker.Choice] = []
    width = min(r.term_width(), 120)

    def numbered(label_path: str, size: int, extra: str = "") -> None:
        print(f"  {r.BOLD}{len(choices):>3}{r.RESET}  {r.human_size(size):>9}  {extra}"
              f"{r.full_path(label_path)}")

    if junk:
        _section("Dev junk", sum(j.size for j in junk), "rebuilds with npm install / pip / the build")
        for j in junk[: args.top]:
            choices.append(picker.Choice(r.full_path(j.path), j.size,
                                         lambda j=j: maint._delete_junk([j], root), path=j.path))
            numbered(j.path, j.size, f"{r.CYAN}{j.group:<7}{r.RESET} ")
        _more(len(junk), args.top)

    if caches:
        _section("Caches, temp and logs", sum(c.size for c in caches), "matched by folder name — check before deleting")
        for c in caches[: args.top]:
            choices.append(commands._path_choice(c.path, c.size, root))
            numbered(c.path, c.size, f"{r.DIM}{r.human_age(c.newest_mtime):>9}{r.RESET}  ")
        _more(len(caches), args.top)

    if dup_files:
        _section("Duplicate files", sum(g["reclaimable"] for g in dup_files), "reclaimable by keeping one copy of each")
        for g in dup_files[:SHOW]:
            print(f"  {r.human_size(g['size']):>9}  × {len(g['paths'])}  "
                  f"{r.BOLD}{os.path.basename(g['paths'][0])}{r.RESET}")
            for p in g["paths"][:4]:
                print(f"  {'':>9}     {r.DIM}{r.truncate_path(p, max(20, width - 20), root)}{r.RESET}")
            if len(g["paths"]) > 4:
                r.note(f"  {'':>9}     … {len(g['paths']) - 4} more copies")
        _more(len(dup_files))

    if dup_folders:
        _section("Look-alike folders", sum(g["reclaimable"] for g in dup_folders), "same name, size within 10% — maybe copies")
        for g in dup_folders[:SHOW]:
            print(f"  {r.human_size(g['size']):>9}  × {len(g['paths'])}  {r.BOLD}{g['name']}{r.RESET}")
            for p in g["paths"][:4]:
                print(f"  {'':>9}     {r.DIM}{r.truncate_path(p, max(20, width - 20), root)}{r.RESET}")
        _more(len(dup_folders))

    if old:
        _section("Untouched for a year+", sum(n.size for n in old), "archive or move to external storage?")
        for n in old[:SHOW]:
            print(f"  {r.human_size(n.size):>9}  {r.DIM}{r.human_age(n.newest_mtime):>9}{r.RESET}  "
                  f"{r.truncate_path(n.path, max(20, width - 30), root)}")
        _more(len(old))

    top_ext = sorted(ext_bytes.items(), key=lambda kv: -kv[1])[:6]
    if top_ext and result.total_size:
        _section("By file type")
        print("  " + f"{r.DIM} · {r.RESET}".join(
            f"{ext} {r.human_size(size)} {r.DIM}({size / result.total_size:.0%}){r.RESET}" for ext, size in top_ext))

    commands._print_cloud_note(result)
    if result.errors:
        print()
        r.note(f"{result.errors} paths were unreadable (permissions) and were skipped")

    if not (junk or caches or dup_files or dup_folders or old):
        print()
        r.note("nothing to clean up here")
    if choices and picker.interactive():
        picker.delete_loop(choices, root)
    elif choices:
        print()
        r.note("run in a terminal to delete numbered rows by typing their number")
    return 0
