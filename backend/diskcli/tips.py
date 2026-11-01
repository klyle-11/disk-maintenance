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


def _load_tips() -> list[Tip]:
    """The tips live in tips.json, which the desktop app's Rust backend reads too."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "tips.json"), encoding="utf-8") as f:
        rows = json.load(f)
    return [
        Tip(
            row["id"],
            row["title"],
            row["body"],
            row.get("command", ""),
            tuple(row.get("when", ("always",))),
            tuple(row.get("only", ())),
        )
        for row in rows
    ]


TIPS: list[Tip] = _load_tips()


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
