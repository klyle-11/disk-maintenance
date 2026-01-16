#!/bin/bash

# ============================================================
# Disk Intelligence - Quick Dev Launcher (macOS/Linux)
# ============================================================
# Assumes dependencies are already installed.
# Use run.sh for first-time setup.
# ============================================================

echo "Starting Disk Intelligence (dev mode)..."
echo ""

# Start Python backend
echo "[1/2] Starting Python backend (port 8000)..."
cd backend
source venv/bin/activate
python3 main.py &
BACKEND_PID=$!
cd ..

sleep 2

# Start Electron frontend
echo "[2/2] Starting Electron frontend..."
cd frontend
npm run dev

# Cleanup
kill $BACKEND_PID 2>/dev/null
