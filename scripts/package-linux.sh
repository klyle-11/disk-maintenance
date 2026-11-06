#!/bin/bash
# Full build and package for Linux (Tauri), x64 or arm64 (e.g. a Raspberry Pi 5).
# Builds for the machine it runs on. Creates .deb, .rpm and AppImage packages
# under frontend/src-tauri/target/release/bundle/.
#
# Needs the WebKitGTK development packages, e.g. on Debian/Ubuntu:
#   sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev \
#     libayatana-appindicator3-dev librsvg2-dev
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "============================================"
echo " Packaging Disk Intelligence for Linux ($(uname -m))"
echo "============================================"
echo ""

command -v cargo >/dev/null || { echo "ERROR: Rust is not installed. Get it from https://rustup.rs"; exit 1; }

echo "[Step 1/2] Installing frontend dependencies..."
cd "$ROOT/frontend"
npm install

echo ""
echo "[Step 2/2] Building the app..."
npm run dist

echo ""
echo "============================================"
echo " SUCCESS! See frontend/src-tauri/target/release/bundle/"
echo "============================================"
