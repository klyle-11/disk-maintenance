"""
di — Disk Intelligence command line.

Lightweight, stdlib-only front end to the same scanning logic and database the
desktop app uses. Run `di --help` for the command list.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import commands
from . import insights
from . import maint
from . import summary
from . import tips
from . import render as r

MB = 1 << 20
GB = 1 << 30


def _size_arg(value: str) -> int:
    """Parse sizes like 500MB, 1.5G, 4096."""
    text = value.strip().upper().rstrip("B")
    multipliers = {"K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}
    if text and text[-1] in multipliers:
        return int(float(text[:-1]) * multipliers[text[-1]])
    return int(float(text))


def _add_common(p: argparse.ArgumentParser, *, depth_default: int = 2) -> None:
    p.add_argument("path", nargs="?", default=os.path.expanduser("~"),
                   help="directory to analyse (default: your home directory)")
    p.add_argument("-d", "--depth", type=int, default=depth_default,
                   help=f"how many levels deep to report (default: {depth_default})")
    p.add_argument("-n", "--top", type=int, default=20,
                   help="rows to show per section (default: 20)")
    p.add_argument("-m", "--min-bytes", type=_size_arg, default=10 * MB,
                   metavar="SIZE", help="ignore anything smaller (default: 10MB)")
    p.add_argument("--days", type=float, default=30.0,
                   help="window for 'recent' in days (default: 30)")
    p.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    p.add_argument("--db", default=None, help="override the database path")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="di",
        description="Disk Intelligence — find what is eating your disk, and what changed lately.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
examples:
  di recent                      what has grown in your home dir this month
  di recent ~/Downloads --days 7 what landed in Downloads this week
  di scan / --depth 1            biggest folders on the whole disk
  di snapshot ~                  record a baseline to compare against later
  di growth ~                    what changed since the last baseline
  di reclaim ~/dev               node_modules, caches and other rebuildable bulk
  di clean ~/dev --older-than 14 dry-run: junk in projects idle 2+ weeks (--yes deletes)
  di caches                      npm/pip/Xcode/editor caches outside your projects
  di guard --auto --install      watchdog: notify + auto-clean when space runs low
  di ballast set 5G              reserve 5 GB that guard releases in an emergency
  di tips                        ways to keep the OS from eating the space you free
  di help <command>              full options for one command

set DI_TIPS=0 to silence the occasional tip after a command.
""",
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    p = sub.add_parser("scan", help="rank folders by size")
    _add_common(p)
    p.add_argument("--save", action="store_true", help="also record a baseline")
    p.add_argument("--label", default=None, help="label for the saved baseline")
    p.set_defaults(func=commands.cmd_scan)

    p = sub.add_parser("recent", help="what has recently taken up space (no baseline needed)")
    _add_common(p, depth_default=3)
    p.add_argument("-f", "--files", type=int, default=15,
                   help="how many individual files to list (0 to skip)")
    p.set_defaults(func=commands.cmd_recent)

    p = sub.add_parser("growth", help="compare against a saved baseline")
    _add_common(p)
    p.set_defaults(depth=None)
    p.add_argument("-b", "--baseline", default=None, help="baseline id (default: most recent)")
    p.add_argument("--save", action="store_true", help="record a new baseline afterwards")
    p.add_argument("--label", default=None, help="label for the new baseline")
    p.set_defaults(func=commands.cmd_growth)

    p = sub.add_parser("snapshot", help="record a baseline for later comparison")
    _add_common(p)
    p.add_argument("--label", default=None, help="a note to remember this baseline by")
    p.add_argument("--keep", type=int, default=None,
                   help="keep only the N newest baselines for this path")
    p.set_defaults(func=commands.cmd_snapshot)

    p = sub.add_parser("snapshots", help="list recorded baselines")
    p.add_argument("path", nargs="?", default=None, help="filter to one path")
    p.add_argument("-n", "--limit", type=int, default=30)
    p.add_argument("--json", action="store_true")
    p.add_argument("--db", default=None)
    p.set_defaults(func=commands.cmd_snapshots)

    p = sub.add_parser("forget", help="delete a baseline")
    p.add_argument("id")
    p.add_argument("--db", default=None)
    p.set_defaults(func=commands.cmd_forget)

    p = sub.add_parser("insights", help="everything worth knowing about one folder (also: di <path>, e.g. di .)")
    p.add_argument("path", nargs="?", default=".", help="folder to look at (default: current folder)")
    p.add_argument("-d", "--depth", type=int, default=12, help="how deep to look for duplicate and old folders")
    p.add_argument("-n", "--top", type=int, default=15, help="numbered rows per section")
    p.add_argument("-m", "--min-bytes", type=_size_arg, default=1 * MB, metavar="SIZE",
                   help="ignore junk and cache folders smaller than this")
    p.add_argument("--days", type=float, default=30.0, help="window for the NEW column")
    p.set_defaults(func=insights.cmd_insights)

    p = sub.add_parser("reclaim", help="find caches and rebuildable folders worth deleting")
    _add_common(p, depth_default=4)
    p.set_defaults(func=commands.cmd_reclaim)

    p = sub.add_parser("clean", help="delete node_modules, __pycache__ and other project build junk")
    p.add_argument("path", nargs="?", default=os.path.expanduser("~/dev"),
                   help="folder holding your projects (default: ~/dev)")
    p.add_argument("-k", "--kinds", default=None,
                   help="comma list of: node, web, python, venv, build (default: node,web,python). build includes .NET bin/obj")
    p.add_argument("--all", action="store_true", help="every kind, including venvs and build output")
    p.add_argument("--older-than", type=float, default=0, metavar="DAYS",
                   help="only projects not worked on for this many days")
    p.add_argument("-m", "--min-bytes", type=_size_arg, default=0, metavar="SIZE")
    p.add_argument("-y", "--yes", action="store_true", help="actually delete (default is a dry run)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=maint.cmd_clean)

    p = sub.add_parser("caches", help="package-manager, IDE and toolchain caches in ~/Library and ~/.*")
    p.add_argument("-m", "--min-bytes", type=_size_arg, default=10 * MB, metavar="SIZE")
    p.add_argument("--include-all", action="store_true",
                   help="also select caches that are slow to rebuild (models, browsers, Docker)")
    p.add_argument("--only", default=None, metavar="NAMES", help="comma list of cache names to select")
    p.add_argument("-v", "--verbose", action="store_true", help="show paths and notes")
    p.add_argument("-y", "--yes", action="store_true", help="actually clean (default is a dry run)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=maint.cmd_caches)

    p = sub.add_parser("guard", help="free-space watchdog: notify, auto-clean, release ballast")
    p.add_argument("--warn", type=_size_arg, default=20 * GB, metavar="SIZE",
                   help="notify below this much free space (default: 20G)")
    p.add_argument("--critical", type=_size_arg, default=8 * GB, metavar="SIZE",
                   help="release ballast below this (default: 8G)")
    p.add_argument("--auto", action="store_true", help="clean auto-safe caches when below --warn")
    p.add_argument("--dev", action="append", metavar="DIR",
                   help="with --auto, also clean project junk here (repeatable)")
    p.add_argument("--older-than", type=float, default=14, metavar="DAYS",
                   help="with --dev, only idle projects (default: 14)")
    p.add_argument("--history", type=int, nargs="?", const=20, default=0, metavar="N",
                   help="show the last N recorded free-space readings")
    p.add_argument("--install", action="store_true", help="run periodically (launchd on macOS, Task Scheduler on Windows, prints a crontab line on Linux)")
    p.add_argument("--every", type=float, default=2, metavar="HOURS", help="interval for --install")
    p.add_argument("--uninstall", action="store_true", help="remove the scheduled guard")
    p.set_defaults(func=maint.cmd_guard)

    p = sub.add_parser("ballast", help="reserve space you can release when the disk fills")
    p.add_argument("action", nargs="?", choices=("status", "set", "release"), default="status")
    p.add_argument("size", nargs="?", type=_size_arg, default=None)
    p.set_defaults(func=maint.cmd_ballast)

    p = sub.add_parser("tips", help="ways to keep freed space from filling back up")
    p.add_argument("--all", action="store_true", help="include tips that don't apply to this machine")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_tips)

    p = sub.add_parser("summary", help="disk, memory, drives and recent changes at a glance (also shown by bare di)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_summary)

    p = sub.add_parser("help", help="show help for di or one of its commands")
    p.add_argument("topic", nargs="?", default=None, metavar="command")
    p.set_defaults(func=None)

    p = sub.add_parser("serve", help="run the HTTP backend the desktop app talks to")
    p.add_argument("--port", type=int, default=int(os.environ.get("BACKEND_PORT", 8001)))
    p.add_argument("--host", default="127.0.0.1")
    p.set_defaults(func=cmd_serve)

    return parser


def cmd_serve(args) -> int:
    """Start the FastAPI backend. Imported lazily so the other commands stay fast."""
    try:
        import uvicorn
    except ImportError:
        r.error("uvicorn is not installed — run:  pip install -r backend/requirements.txt")
        return 2

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    from backend.main import app  # noqa: PLC0415

    print(f"  Disk Intelligence backend on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


def cmd_tips(args) -> int:
    payload = tips.tips_payload()
    rows = payload["tips"] if args.all else [t for t in payload["tips"] if t["relevant"]]
    if args.json:
        print(json.dumps({**payload, "tips": rows}, indent=2))
        return 0
    print()
    print(r.header("Keeping space free", f"free now: {r.human_size(payload['free_bytes'])}"))
    print(r.rule())
    by_id = {t.id: t for t in tips.TIPS}
    for row in rows:
        print(tips.format_tip(by_id[row["id"]], r))
        print()
    if not args.all:
        r.note("showing tips that apply to this machine — di tips --all for the rest")
    return 0


def cmd_summary(args) -> int:
    if args.json:
        print(json.dumps(summary.collect(), indent=2))
    else:
        summary.print_summary()
    return 0


def _print_commands(parser: argparse.ArgumentParser) -> None:
    """One line per command, for under the summary."""
    sub = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
    print()
    print(f"  {r.BOLD}Commands{r.RESET}")
    for action in sub._choices_actions:
        print(f"  {action.dest:<10} {r.DIM}{action.help}{r.RESET}")
    print()
    r.note("  di help <command> for options · di --help for examples")


def cmd_help(parser: argparse.ArgumentParser, topic: str | None) -> int:
    if not topic:
        summary.print_summary()
        print()
        parser.print_help()
        return 0
    sub = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
    if topic not in sub.choices:
        r.error(f"no command named {topic!r} — try: {', '.join(sub.choices)}")
        return 2
    sub.choices[topic].print_help()
    return 0


# Commands whose output is a table for a person, where a trailing tip fits.
_TIP_AFTER = {"insights", "scan", "recent", "growth", "reclaim", "clean", "caches"}


def _maybe_tip(args) -> None:
    if args.command not in _TIP_AFTER or getattr(args, "json", False) or not sys.stdout.isatty():
        return
    tip = tips.pick_tip()
    if tip:
        print()
        print(tips.format_tip(tip, r))


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    argv = sys.argv[1:] if argv is None else argv
    # `di .` / `di ~/proj`: a path where a command would go means insights for it.
    commands_by_name = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction)).choices
    if (argv and argv[0] not in commands_by_name and not argv[0].startswith("-")
            and os.path.isdir(os.path.expanduser(argv[0]))):
        argv = ["insights", *argv]
    args = parser.parse_args(argv)

    if not getattr(args, "command", None):
        _print_commands(parser)
        summary.print_summary()
        return 0
    if args.command == "help":
        return cmd_help(parser, args.topic)

    # `growth` inherits depth from its baseline when not given explicitly.
    if args.command == "growth" and args.depth is None:
        args.depth = None

    try:
        code = args.func(args) or 0
        _maybe_tip(args)
        return code
    except KeyboardInterrupt:
        print(file=sys.stderr)
        r.note("cancelled")
        return 130
    except BrokenPipeError:
        # Downstream `head`/`less` closed the pipe; exit quietly.
        try:
            sys.stdout.close()
        except Exception:
            pass
        return 0


if __name__ == "__main__":
    sys.exit(main())
