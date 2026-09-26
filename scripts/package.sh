#!/bin/bash
# Full build and package for macOS.
# Creates a .dmg in release/. Run from anywhere: ./scripts/package.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "============================================"
echo " Packaging Disk Intelligence for macOS"
echo "============================================"
echo ""

echo "[Step 1/4] Building Python backend..."
"$ROOT/scripts/build-backend.sh"

echo ""
echo "[Step 2/4] Installing frontend dependencies..."
cd "$ROOT/frontend"
npm install

echo ""
echo "[Step 3/4] Building frontend and creating installer..."
# Without a Developer ID, fall back to ad-hoc signing. Apple Silicon refuses
# to run an unsigned app at all, so this is not optional. Set CSC_NAME to sign
# with a real identity instead.
if [ -z "${CSC_NAME:-}" ]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  echo "  (no CSC_NAME set — using an ad-hoc signature)"
fi
npm run dist:mac

echo ""
echo "[Step 4/4] Verifying the packaged backend..."
"$ROOT/scripts/verify-package.sh"

echo ""
echo "============================================"
echo " SUCCESS! Check release/ for the .dmg file"
echo "============================================"
