"""
What the desktop app needs to know about a di command before it runs one:
the command list for the di window, and whether a command line is allowed and
whether it changes the disk (so the app asks first).

Shared by the Electron backend (backend/di_runner.py imports it) and the
Tauri app, which runs it as `python -m diskcli.app_bridge` and reads JSON:

    python -m diskcli.app_bridge commands
    python -m diskcli.app_bridge check <di args...>

Decided from di's own parser, so abbreviations (`--ye`) and bundled short
flags (`-vy`) are read the same way di reads them.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys

from .__main__ import build_parser, resolve_argv

MAX_ARGS = 32
MAX_ARG_LEN = 4096

# `serve` would start a second backend.
BLOCKED_COMMANDS = {"serve"}


class DiRequestError(ValueError):
    """The request can't be run; the message is shown to the user."""

    def __init__(self, message: str, needs_confirm: bool = False):
        super().__init__(message)
        self.needs_confirm = needs_confirm


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
    """Why this command changes the disk or the system, or None for a read-only one."""
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
    """The command line as di should get it, or DiRequestError."""
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


def check(argv: list[str]) -> dict:
    """{"argv": [...], "needs_confirm": reason or None} or {"error": message}."""
    try:
        argv = validate_argv(argv)
    except DiRequestError as e:
        return {"error": str(e)}
    return {"argv": argv, "needs_confirm": destructive_reason(argv)}


def main(argv: list[str]) -> int:
    if argv[:1] == ["commands"]:
        out: dict = {"commands": command_list()}
    elif argv[:1] == ["check"]:
        out = check(argv[1:])
    else:
        print("usage: python -m diskcli.app_bridge commands | check <di args...>", file=sys.stderr)
        return 2
    sys.stdout.write(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
