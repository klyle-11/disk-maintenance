"""
Numbered pick-to-delete prompt shared by every `di` command that lists rows
(`di .`, scan, recent, growth, reclaim, clean, caches).

After a listing, the command stays open: type a row's number to delete it
(always asks y/n first), Enter to see what is left, and q to leave.
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
    # What `delete` removes, when it is one path: lets the prompt notice it is already gone.
    path: str | None = None


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


def _gone(c: Choice) -> bool:
    return c.path is not None and not os.path.lexists(c.path)


def _print_remaining(choices: list[Choice], done: set[int]) -> None:
    print()
    for i, c in enumerate(choices, 1):
        if i not in done and not _gone(c):
            print(f"  {r.BOLD}{i:>3}{r.RESET}  {r.human_size(c.size):>9}  {c.label}")


def delete_loop(choices: list[Choice], free_path: str) -> None:
    if not choices:
        return
    n = len(choices)
    done: set[int] = set()
    freed_total = 0
    hint = f"type a number (1-{n}) to delete that row · Enter to list what's left · q to quit"
    print()
    r.note(hint)
    try:
        while any(i not in done and not _gone(c) for i, c in enumerate(choices, 1)):
            answer = _ask(f"{r.BOLD}delete #{r.RESET} ")
            if answer is None or answer in ("q", "quit", "exit"):
                break
            if answer == "":
                _print_remaining(choices, done)
                r.note(hint)
                continue
            answer = answer.lstrip("#")
            if not answer.isdigit() or not 1 <= int(answer) <= n:
                r.warn(f"enter a number from 1 to {n}, or q to quit")
                continue
            i = int(answer)
            c = choices[i - 1]
            if i in done or _gone(c):
                r.note(f"  #{i} is already deleted")
                continue
            ok = _ask(f"  delete {c.label} ({r.human_size(c.size)})? [y/n] ")
            if ok is None:
                break
            if ok not in ("y", "yes"):
                r.note("  kept")
                continue
            print(f"  {r.DIM}deleting…{r.RESET}", flush=True)
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
    except KeyboardInterrupt:
        print()
    if done or freed_total:
        print(f"\n  {r.BOLD}{len(done)}{r.RESET} deleted · {r.human_size(freed_total)} freed")
