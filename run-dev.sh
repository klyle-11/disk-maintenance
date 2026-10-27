#!/bin/bash

# ============================================================
# Disk Intelligence - Quick Dev Launcher (macOS/Linux)
# ============================================================
# Assumes dependencies are already installed.
# Use run.sh for first-time setup.
# ============================================================

cd "$(dirname "$0")/frontend"
echo "Starting Disk Intelligence (dev mode)..."
npm run dev
