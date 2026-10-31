"""
Run `di` commands for the desktop app.

The app's di window is a terminal onto the real CLI: each run is a `di`
subprocess whose coloured output is streamed back over SSE, so what the window
shows is exactly what `di` prints in a terminal. A subprocess (rather than
calling diskcli in-process) keeps runs isolated, lets the window stop one by
killing it, and means `print()` from one run can't land in another.

Starting a run is a JSON POST, which a cross-site page can't send without a
CORS preflight; the GET that streams it only takes the run's random id. So a
link or <img> on some web page can't start `di clean --yes` on this machine.
"""

from __future__ import annotations

import argparse
import asyncio
import codecs
import contextlib
import io
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field

from backend.diskcli.__main__ import build_parser, resolve_argv

MAX_ARGS = 32
MAX_ARG_LEN = 4096
MAX_LIVE_RUNS = 4
# A registered run that nobody starts streaming within this long is dropped.
PENDING_TTL_SECONDS = 60

# `serve` would start a second backend.
BLOCKED_COMMANDS = {"serve"}


class DiRequestError(ValueError):
    """The request can't be run; the message is shown to the user."""

    def __init__(self, message: str, needs_confirm: bool = False):
        super().__init__(message)
        self.needs_confirm = needs_confirm


@dataclass
class DiRun:
    id: str
    argv: list[str]
    columns: int
    created: float = field(default_factory=time.time)
    started: bool = False
    proc: subprocess.Popen | None = None


_runs: dict[str, DiRun] = {}
_lock = threading.Lock()


def _subparsers(parser: argparse.ArgumentParser) -> argparse._SubParsersAction:
    return next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))


def command_list() -> list[dict]:
    """Every di command with its one-line help, for the window's command bar."""
    sub = _subparsers(build_parser())
    return [
        {"name": action.dest, "help": action.help or ""}
        for action in sub._choices_actions
        if action.dest not in BLOCKED_COMMANDS
    ]


def _parse(argv: list[str]) -> argparse.Namespace | None:
    """
    Parse argv exactly as di will. None when di would reject it (or print
    help and exit); the subprocess then shows di's own message.
    """
    parser = build_parser()
    sink = io.StringIO()
    try:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            return parser.parse_args(resolve_argv(parser, argv))
    except SystemExit:
        return None


def destructive_reason(argv: list[str]) -> str | None:
    """
    Why this command changes the disk or the system, or None for a read-only
    one. Decided from di's own parser, so abbreviations (`--ye`) and bundled
    short flags (`-vy`) are caught the same way di reads them.
    """
    args = _parse(argv)
    if args is None:
        return None
    command = getattr(args, "command", None)
    if command in ("clean", "caches") and getattr(args, "yes", False):
        return f"di {command} --yes deletes files"
    if command == "guard":
        if getattr(args, "install", False):
            return "di guard --install schedules a background job"
        if getattr(args, "uninstall", False):
            return "di guard --uninstall removes the scheduled job"
        if getattr(args, "auto", False):
            return "di guard --auto cleans caches when space is low"
    if command == "ballast" and getattr(args, "action", None) in ("set", "release"):
        return f"di ballast {args.action} writes or deletes the ballast file"
    if command == "forget":
        return "di forget deletes a saved baseline"
    return None


def _expand_tilde(arg: str) -> str:
    """What a shell would do with `~` and `~/dev`; the window has no shell."""
    if arg == "~" or arg.startswith("~/") or arg.startswith("~" + os.sep):
        return os.path.expanduser(arg)
    return arg


def validate_argv(argv: list[str]) -> list[str]:
    if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
        raise DiRequestError("args must be a list of strings")
    if len(argv) > MAX_ARGS:
        raise DiRequestError(f"too many arguments (max {MAX_ARGS})")
    for arg in argv:
        if len(arg) > MAX_ARG_LEN:
            raise DiRequestError("argument too long")
        if "\x00" in arg:
            raise DiRequestError("arguments can't contain NUL characters")
    argv = [_expand_tilde(a) for a in argv]
    args = _parse(argv)
    if args is not None and getattr(args, "command", None) in BLOCKED_COMMANDS:
        raise DiRequestError(f"di {args.command} can't run inside the app")
    return argv


def _expire_pending() -> None:
    now = time.time()
    for run_id, run in list(_runs.items()):
        if not run.started and now - run.created > PENDING_TTL_SECONDS:
            _runs.pop(run_id, None)


def register(argv: list[str], columns: int, confirmed: bool) -> DiRun:
    """Check a command and hold it until its stream connects."""
    argv = validate_argv(argv)
    reason = destructive_reason(argv)
    if reason and not confirmed:
        raise DiRequestError(reason, needs_confirm=True)
    with _lock:
        _expire_pending()
        if len(_runs) >= MAX_LIVE_RUNS:
            raise DiRequestError(f"already running {MAX_LIVE_RUNS} di commands; stop one first")
        run = DiRun(id=uuid.uuid4().hex, argv=argv, columns=max(40, min(int(columns), 400)))
        _runs[run.id] = run
    return run


def claim(run_id: str) -> DiRun | None:
    """Hand a registered run to its stream, once."""
    with _lock:
        run = _runs.get(run_id)
        if run is None or run.started:
            return None
        run.started = True
        return run


def _command(argv: list[str]) -> list[str]:
    """
    How to start di. The packaged backend is one PyInstaller binary with no
    Python next to it, so it runs di through its own `--di` mode; in
    development the same flag works on main.py.
    """
    if getattr(sys, "frozen", False):
        return [sys.executable, "--di", *argv]
    main_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "main.py")
    return [sys.executable, main_py, "--di", *argv]


def _environment(columns: int) -> dict[str, str]:
    env = dict(os.environ)
    env.pop("NO_COLOR", None)
    # Not a person at a keyboard: keeps di's pick-to-delete prompt off.
    env.pop("DI_TTY", None)
    env.update({
        "DI_FORCE_COLOR": "1",
        "COLUMNS": str(columns),
        "LINES": "50",
        "PYTHONUNBUFFERED": "1",
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "TERM": "xterm-256color",
    })
    return env


def _spawn(run: DiRun) -> subprocess.Popen:
    kwargs: dict = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        # Own process group, so stopping a run also stops anything di started.
        kwargs["start_new_session"] = True
    return subprocess.Popen(
        _command(run.argv),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        # One stream, as in a terminal: kept apart, the spinner's summary and
        # error lines arrive out of order with the table they belong to.
        stderr=subprocess.STDOUT,
        env=_environment(run.columns),
        cwd=os.path.expanduser("~"),
        **kwargs,
    )


def stop(run: DiRun) -> None:
    proc = run.proc
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            proc.kill()
        else:
            os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=2)
    except (ProcessLookupError, PermissionError):
        pass
    except subprocess.TimeoutExpired:
        try:
            if os.name == "nt":
                proc.kill()
            else:
                os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def finish(run: DiRun) -> None:
    stop(run)
    with _lock:
        _runs.pop(run.id, None)


def _pump(stream, name: str, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
    """
    Copy a pipe into the queue as it arrives. Reads raw chunks rather than
    lines: di's spinner redraws one line with \\r and never ends it.
    """
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    fd = stream.fileno()
    try:
        while True:
            chunk = os.read(fd, 8192)
            if not chunk:
                break
            text = decoder.decode(chunk)
            if text:
                loop.call_soon_threadsafe(queue.put_nowait, (name, text))
        tail = decoder.decode(b"", final=True)
        if tail:
            loop.call_soon_threadsafe(queue.put_nowait, (name, tail))
    except OSError:
        pass
    finally:
        loop.call_soon_threadsafe(queue.put_nowait, (name, None))


async def stream(run: DiRun, is_disconnected):
    """
    Yield (kind, payload) until di exits: ("out", text) for output (stdout
    and stderr together), then ("exit", code). Stops di if the client goes away.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    try:
        run.proc = _spawn(run)
    except OSError as e:
        finish(run)
        yield "err", f"could not start di: {e}\n"
        yield "exit", 127
        return

    threading.Thread(target=_pump, args=(run.proc.stdout, "out", loop, queue), daemon=True).start()

    try:
        while True:
            try:
                name, text = await asyncio.wait_for(queue.get(), timeout=0.25)
            except asyncio.TimeoutError:
                if await is_disconnected():
                    return
                continue
            if text is None:
                break
            yield name, text
        code = await loop.run_in_executor(None, run.proc.wait)
        yield "exit", code
    finally:
        finish(run)
