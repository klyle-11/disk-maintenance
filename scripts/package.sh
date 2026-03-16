#!/bin/bash
# Full build and package for macOS
# Creates a .dmg installer in the release/ directory
# Run from the project root: ./scripts/package.sh

set -e

echo "============================================"
echo " Packaging Disk Intelligence for macOS"
echo "============================================"
echo ""

# Step 1: Build the Python backend
echo "[Step 1/3] Building Python backend..."
"$(dirname "$0")/build-backend.sh"

# Step 2: Install frontend dependencies
echo ""
echo "[Step 2/3] Installing frontend dependencies..."
cd "$(dirname "$0")/../frontend"
npm install

# Step 3: Build frontend and create Electron installer
echo ""
echo "[Step 3/3] Building frontend and creating installer..."
npm run dist:mac

echo ""
echo "============================================"
echo " SUCCESS! Check release/ for the .dmg file"
echo "============================================"
