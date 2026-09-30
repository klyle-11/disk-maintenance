#!/bin/bash
# Full build and package for Linux (x64 or arm64, e.g. a Raspberry Pi 5).
# Builds for the machine it runs on: PyInstaller can't cross-compile, so an
# arm64 package has to be built on an arm64 machine.
# Creates an AppImage (and a .deb when fpm is available) in release/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="$(uname -m)"

echo "============================================"
echo " Packaging Disk Intelligence for Linux ($ARCH)"
echo "============================================"
echo ""

echo "[Step 1/3] Building Python backend..."
"$ROOT/scripts/build-backend.sh"

echo ""
echo "[Step 2/3] Installing frontend dependencies..."
cd "$ROOT/frontend"
npm install

echo ""
echo "[Step 3/3] Building frontend and creating packages..."
TARGETS=(AppImage deb)
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  # electron-builder's bundled fpm (used for .deb) is x86-64 only; use the system one on ARM.
  if command -v fpm >/dev/null 2>&1; then
    export USE_SYSTEM_FPM=true
  else
    echo "  (fpm not found — skipping .deb; install with: sudo apt install ruby-dev build-essential && sudo gem install fpm)"
    TARGETS=(AppImage)
  fi
fi
npm run build
npx electron-builder --linux "${TARGETS[@]}"

echo ""
echo "============================================"
echo " SUCCESS! Check release/ for ${TARGETS[*]}"
echo "============================================"
