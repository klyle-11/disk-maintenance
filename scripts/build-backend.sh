#!/bin/bash
# Build the Python backend into a standalone executable using PyInstaller
# Run from the project root: ./scripts/build-backend.sh

set -e

echo "============================================"
echo " Building Disk Intelligence Backend"
echo "============================================"

cd "$(dirname "$0")/../backend"

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python3 is not installed or not in PATH"
    exit 1
fi

# Build in a venv: Debian / Raspberry Pi OS refuse system-wide pip installs (PEP 668).
if [ ! -x venv/bin/python ]; then
    echo "Creating build venv in backend/venv..."
    python3 -m venv venv || { echo "ERROR: python3 -m venv failed (on Debian/Pi OS: sudo apt install python3-venv)"; exit 1; }
fi
PY=venv/bin/python

echo "Installing PyInstaller and backend dependencies..."
$PY -m pip install --upgrade pip pyinstaller
$PY -m pip install -r requirements.txt

# Clean previous build
rm -rf dist build

# Run PyInstaller
echo "Running PyInstaller..."
$PY -m PyInstaller disk-intelligence.spec --clean

echo ""
if [ -f "dist/disk-intelligence-backend" ]; then
    echo "SUCCESS: Backend built at backend/dist/disk-intelligence-backend"
else
    echo "ERROR: Build failed - executable not found"
    exit 1
fi
