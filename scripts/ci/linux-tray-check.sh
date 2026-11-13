#!/usr/bin/env bash
# Linux tray check: the close button and the tray behave as on macOS/Windows.
#
#   1. No tray on the desktop: closing the main window quits the app.
#   2. A StatusNotifierItem tray (as on Raspberry Pi OS): the icon registers,
#      closing the main window leaves the app running in the tray, and the
#      tray menu's Open, Quick panel and Quit work. Screenshot of the panel
#      on its own: <out>/tray-panel.png.
#
# Usage: linux-tray-check.sh <app binary> <out dir>
# Needs: Xvfb, openbox, wmctrl, xdotool, imagemagick, dbus-x11, and the
# system Python with python3-dbus and python3-gi.
set -u
APP=$1
OUT=$2
PY=${PY:-/usr/bin/python3}
TRAY="$PY $(dirname "$0")/sni_tray.py"
mkdir -p "$OUT"
fail=0

check() { # check <description> <command...>
  local what=$1
  shift
  if "$@"; then echo "ok:   $what"; else echo "FAIL: $what"; fail=1; fi
}
alive() { kill -0 "$PID" 2>/dev/null; }
shown() { [ "$(xdotool search --onlyvisible --name 'Disk Intelligence' 2>/dev/null | wc -l)" -ge 1 ]; }
hidden() { ! shown; }

desktop() { # desktop <display>: a fresh X display, session bus and window manager
  export DISPLAY=$1
  Xvfb "$DISPLAY" -screen 0 1600x1000x24 >/dev/null 2>&1 &
  XVFB=$!
  sleep 2
  eval "$(dbus-launch --sh-syntax)"
  openbox >/dev/null 2>&1 &
  WM=$!
  sleep 1
}
teardown() {
  kill "$PID" "$WM" "${SNI:-}" "$DBUS_SESSION_BUS_PID" "$XVFB" 2>/dev/null
  wait 2>/dev/null
}
launch() { # launch <log>
  HOME=$(mktemp -d) "$APP" >"$1" 2>&1 &
  PID=$!
  sleep 20
}

echo "== No tray"
desktop :91
launch "$OUT/app-no-tray.log"
check "app is up" alive
check "main window shows" shown
wmctrl -c "Disk Intelligence"
sleep 3
check "closing the main window quits (nothing would show it again)" bash -c "! kill -0 $PID 2>/dev/null"
teardown

echo "== StatusNotifierItem tray"
desktop :92
$TRAY serve >"$OUT/tray.log" 2>&1 &
SNI=$!
sleep 1
launch "$OUT/app-tray.log"
check "app is up" alive
check "tray icon registered" grep -q '^ITEM ' "$OUT/tray.log"
wmctrl -c "Disk Intelligence"
sleep 3
check "closing the main window keeps the app running" alive
check "main window hidden" hidden
$TRAY click "Quick panel"
sleep 6
check "Quick panel opens on its own" shown
import -window root "$OUT/tray-panel.png" || true
$TRAY click "Open Disk Intelligence"
sleep 3
check "Open brings the main window back" shown
$TRAY click "Quit"
sleep 3
check "tray Quit exits" bash -c "! kill -0 $PID 2>/dev/null"
teardown

exit $fail
