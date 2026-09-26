#!/bin/bash
# Verify a packaged macOS build will actually run on someone else's machine.
#
# Checks the things that have silently broken it before: a missing or
# unsigned nested backend, a lost executable bit, and the quarantine flag that
# makes Gatekeeper SIGKILL the backend with no error message at all.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=0

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

for APP in "$ROOT/release"/mac*/*.app; do
  [ -d "$APP" ] || continue
  echo ""
  echo "Checking $(basename "$(dirname "$APP")")/$(basename "$APP")"

  BACKEND="$APP/Contents/Resources/backend/disk-intelligence-backend"

  if [ ! -f "$BACKEND" ]; then
    fail "backend executable is missing from the bundle"
    continue
  fi
  pass "backend is bundled"

  if [ -x "$BACKEND" ]; then
    pass "backend is executable"
  else
    fail "backend has lost its executable bit"
  fi

  if codesign --verify --strict "$BACKEND" 2>/dev/null; then
    pass "backend signature verifies"
  else
    fail "backend signature is invalid — Gatekeeper will kill it"
  fi

  if codesign --verify --deep --strict "$APP" 2>/dev/null; then
    pass "app signature verifies"
  else
    fail "app signature is invalid — Apple Silicon will refuse to launch it"
  fi

  if codesign -d --entitlements - "$BACKEND" 2>&1 | grep -q "disable-library-validation"; then
    pass "backend carries the entitlements it needs"
  else
    fail "backend is missing its entitlements"
  fi

  # The backend must start when it is launched the way the app launches it.
  PORT=8123
  "$BACKEND" --port "$PORT" >/tmp/di-verify.log 2>&1 &
  BPID=$!
  READY=0
  for _ in $(seq 1 40); do
    sleep 1
    if curl -fsS -m 1 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q ok; then
      READY=1; break
    fi
  done
  kill -- -"$BPID" 2>/dev/null || kill "$BPID" 2>/dev/null || true
  wait "$BPID" 2>/dev/null || true

  if [ "$READY" = "1" ]; then
    pass "backend starts and answers /api/health"
  else
    fail "backend did not start — see /tmp/di-verify.log"
  fi
done

echo ""
if [ "$FAILED" = "0" ]; then
  echo "All checks passed."
else
  echo "Some checks FAILED — this build would not work on a clean machine."
  exit 1
fi
