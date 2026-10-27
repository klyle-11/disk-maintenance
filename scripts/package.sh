#!/bin/bash
# Full build and package for macOS (Tauri).
# Creates a .app and .dmg under frontend/src-tauri/target/release/bundle/.
# Run from anywhere: ./scripts/package.sh
#
# The legacy Electron + Python build is still available:
#   ./scripts/build-backend.sh && npm --prefix frontend run dist:electron:mac
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "============================================"
echo " Packaging Disk Intelligence for macOS"
echo "============================================"
echo ""

command -v cargo >/dev/null || { echo "ERROR: Rust is not installed. Get it from https://rustup.rs"; exit 1; }

echo "[Step 1/2] Installing frontend dependencies..."
cd "$ROOT/frontend"
npm install

echo ""
echo "[Step 2/2] Building the app..."
# Without a Developer ID the app gets an ad-hoc signature (tauri.conf.json
# signingIdentity "-"); Apple Silicon refuses to run an unsigned app at all.
# Set APPLE_SIGNING_IDENTITY to sign with a real identity instead.
npm run dist

echo ""
echo "============================================"
echo " SUCCESS! See frontend/src-tauri/target/release/bundle/"
echo "============================================"
