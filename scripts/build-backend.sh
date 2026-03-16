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

# Install PyInstaller if not present
if ! python3 -m pip show pyinstaller &> /dev/null; then
    echo "Installing PyInstaller..."
    python3 -m pip install pyinstaller
fi

# Install backend dependencies
echo "Installing backend dependencies..."
python3 -m pip install -r requirements.txt

# Clean previous build
rm -rf dist build

# Set the du-hast-much path
export DU_HAST_MUCH_PATH="$(dirname "$0")/../../du-hast-much"

# Run PyInstaller
echo "Running PyInstaller..."
python3 -m PyInstaller disk-intelligence.spec --clean

echo ""
if [ -f "dist/disk-intelligence-backend" ]; then
    echo "SUCCESS: Backend built at backend/dist/disk-intelligence-backend"
else
    echo "ERROR: Build failed - executable not found"
    exit 1
fi
