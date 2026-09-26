"""
Numbered pick-to-delete prompt shared by `di reclaim`, `di clean` and `di caches`.

After a listing, the command stays open: type a row's number to delete it,
one at a time, and Enter (or q) to leave.
"""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from typing import Callable

from . import render as r


def interactive() -> bool:
    """
    True when a person is at the keyboard. The bash `di` launcher sets DI_TTY,
    because native Windows Python under Git Bash's mintty sees pipes, not a console.
    """
    if os.environ.get("DI_TTY") == "1":
        return True
    return sys.stdin.isatty() and sys.stdout.isatty()


@dataclass
class Choice:
    label: str
    size: int
    delete: Callable[[], object]
    # Ask y/N first: for guesses by folder name, or caches that are slow to rebuild.
    confirm: bool = False


def _free(path: str) -> int:
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return 0


def _ask(prompt: str) -> str | None:
    try:
        return input(prompt).strip().lower()
    except EOFError:
        print()
        return None


def delete_loop(choices: list[Choice], free_path: str) -> None:
    if not choices:
        return
    n = len(choices)
    done: set[int] = set()
    freed_total = 0
    print()
    r.note(f"type a number (1-{n}) to delete it, one at a time · Enter or q to quit")
    while len(done) < n:
        answer = _ask(f"{r.BOLD}delete #{r.RESET} ")
        if answer is None or answer in ("", "q", "quit", "exit"):
            break
        if not answer.isdigit() or not 1 <= int(answer) <= n:
            r.warn(f"enter a number from 1 to {n}")
            continue
        i = int(answer)
        if i in done:
            r.note(f"  #{i} is already deleted")
            continue
        c = choices[i - 1]
        if c.confirm:
            ok = _ask(f"  delete {c.label} ({r.human_size(c.size)})? [y/N] ")
            if ok is None:
                break
            if ok not in ("y", "yes"):
                r.note("  kept")
                continue
        print(f"  {r.DIM}deleting {c.label}…{r.RESET}", flush=True)
        before = _free(free_path)
        try:
            c.delete()
        except OSError as exc:
            freed = _free(free_path) - before
            freed_total += max(freed, 0)
            r.error(f"#{i}: {exc} — free space {r.human_size(freed, signed=True)}")
            continue
        freed = _free(free_path) - before
        freed_total += max(freed, 0)
        done.add(i)
        print(f"  {r.GREEN}✓{r.RESET} #{i} {c.label} {r.DIM}— free space {r.human_size(freed, signed=True)}{r.RESET}")
    if done or freed_total:
        print(f"\n  {r.BOLD}{len(done)}{r.RESET} deleted · {r.human_size(freed_total)} freed")
