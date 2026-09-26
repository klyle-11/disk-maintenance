"""
Terminal output helpers: human sizes, colour, bars, tables.

Colour is disabled automatically when stdout is not a TTY or NO_COLOR is set,
so piping into grep/jq stays clean.
"""

from __future__ import annotations

import os
import shutil
import sys
import time

def _prepare_windows_console() -> bool:
    """
    Turn on ANSI escape handling in the Windows console (off by default in
    conhost), and make redirected output survive box-drawing characters that
    the legacy code page can't encode. Returns whether ANSI is available.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    try:
        import ctypes  # noqa: PLC0415

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        # ENABLE_VIRTUAL_TERMINAL_PROCESSING
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:
        return False


_ANSI_OK = _prepare_windows_console() if sys.platform == "win32" else True

_USE_COLOR = (
    _ANSI_OK
    and sys.stdout.isatty()
    and os.environ.get("NO_COLOR") is None
    and os.environ.get("TERM") != "dumb"
)


def _c(code: str) -> str:
    return code if _USE_COLOR else ""


DIM = _c("\033[2m")
BOLD = _c("\033[1m")
RESET = _c("\033[0m")
RED = _c("\033[31m")
GREEN = _c("\033[32m")
YELLOW = _c("\033[33m")
BLUE = _c("\033[34m")
CYAN = _c("\033[36m")
MAGENTA = _c("\033[35m")


def term_width(default: int = 100) -> int:
    try:
        return shutil.get_terminal_size((default, 24)).columns
    except Exception:
        return default


def human_size(n: int | float, signed: bool = False) -> str:
    """Format a byte count. `signed` prefixes + for positive deltas."""
    sign = ""
    if signed:
        sign = "+" if n > 0 else ("-" if n < 0 else " ")
    n = abs(n)
    for unit, threshold in (
        ("TB", 1 << 40),
        ("GB", 1 << 30),
        ("MB", 1 << 20),
        ("KB", 1 << 10),
    ):
        if n >= threshold:
            value = n / threshold
            precision = 1 if value >= 10 else 2
            return f"{sign}{value:.{precision}f} {unit}"
    return f"{sign}{int(n)} B"


def human_count(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def human_age(ts: float) -> str:
    """Render a timestamp as an age like '3d ago'."""
    if not ts:
        return "-"
    delta = time.time() - ts
    if delta < 0:
        return "now"
    for unit, seconds in (("y", 31_536_000), ("mo", 2_592_000), ("d", 86400), ("h", 3600), ("m", 60)):
        if delta >= seconds:
            return f"{int(delta / seconds)}{unit} ago"
    return "just now"


def bar(fraction: float, width: int = 18, color: str = "") -> str:
    """A proportional block bar. `fraction` is clamped to 0..1."""
    fraction = max(0.0, min(1.0, fraction))
    filled = int(round(fraction * width))
    body = "█" * filled + DIM + "·" * (width - filled) + RESET
    return f"{color}{body}{RESET}" if color else body


def heat_color(fraction: float) -> str:
    """Colour a bar by how dominant the row is."""
    if fraction >= 0.35:
        return RED
    if fraction >= 0.15:
        return YELLOW
    if fraction >= 0.05:
        return CYAN
    return BLUE


def delta_color(delta: int) -> str:
    if delta > 0:
        return RED
    if delta < 0:
        return GREEN
    return DIM


def truncate_path(path: str, width: int, root: str | None = None) -> str:
    """
    Shorten a path to fit `width`, preferring to keep the tail (the part that
    identifies the folder) and eliding the middle.
    """
    display = path
    if root and display.startswith(root):
        display = display[len(root) :].lstrip(os.sep) or "."
    home = os.path.expanduser("~")
    if display.startswith(home):
        display = "~" + display[len(home) :]
    if len(display) <= width:
        return display
    if width <= 3:
        return display[-width:]
    keep_tail = width - 3
    return "…" + display[-keep_tail:]


def header(title: str, subtitle: str = "") -> str:
    line = f"{BOLD}{title}{RESET}"
    if subtitle:
        line += f"  {DIM}{subtitle}{RESET}"
    return line


def rule(width: int | None = None) -> str:
    return f"{DIM}{'─' * (width or min(term_width(), 100))}{RESET}"


def warn(msg: str) -> None:
    print(f"{YELLOW}warning:{RESET} {msg}", file=sys.stderr)


def error(msg: str) -> None:
    print(f"{RED}error:{RESET} {msg}", file=sys.stderr)


def note(msg: str) -> None:
    print(f"{DIM}{msg}{RESET}")


class Spinner:
    """Minimal inline progress indicator; a no-op when not on a TTY."""

    FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

    def __init__(self, label: str):
        self.label = label
        self.enabled = _ANSI_OK and sys.stderr.isatty() and os.environ.get("NO_COLOR") is None
        self.i = 0
        self.last = 0.0

    def tick(self, detail: str = "") -> None:
        if not self.enabled:
            return
        now = time.time()
        if now - self.last < 0.08:
            return
        self.last = now
        frame = self.FRAMES[self.i % len(self.FRAMES)]
        self.i += 1
        width = term_width() - 4
        line = f"{frame} {self.label} {DIM}{detail}{RESET}"
        print(f"\r\033[2K{line[:width]}", end="", file=sys.stderr, flush=True)

    def done(self, summary: str = "") -> None:
        if not self.enabled:
            return
        print("\r\033[2K", end="", file=sys.stderr, flush=True)
        if summary:
            print(f"{DIM}{summary}{RESET}", file=sys.stderr)
