#!/usr/bin/env bash
# di — Disk Intelligence command line.
# Symlink this somewhere on your PATH, e.g.
#   ln -s "$PWD/di" ~/.local/bin/di
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT="$(cd -P "$(dirname "$SOURCE")" && pwd)"

PY="${DI_PYTHON:-}"
if [ -z "$PY" ]; then
  # Run each candidate: on Windows, python3/python may be Microsoft Store stubs that exist but fail.
  for candidate in python3 python "py -3"; do
    if $candidate -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
      PY="$candidate"; break
    fi
  done
fi
if [ -z "$PY" ]; then
  echo "di: no python3 found on PATH (set DI_PYTHON to override)" >&2
  exit 127
fi

export PYTHONPATH="$ROOT/backend${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUTF8=1
# Native Windows Python under mintty sees pipes, not a terminal; tell it a person is here.
if [ -t 0 ] && [ -t 1 ]; then export DI_TTY=1; fi
exec $PY -m diskcli "$@"
