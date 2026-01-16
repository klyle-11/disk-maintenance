#!/bin/bash

# ============================================================
# Disk Intelligence - Application Launcher (macOS/Linux)
# ============================================================
# This script starts both Python backend
# and Electron frontend.
# ============================================================

echo "============================================"
echo "   Disk Intelligence - Starting..."
echo "============================================"
echo ""

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed or not in PATH"
    echo "Please install Python 3.10+ from https://www.python.org/"
    exit 1
fi

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed or not in PATH"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Install backend dependencies
echo "[1/4] Installing backend dependencies..."
cd backend
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

# Activate virtual environment (different on macOS vs Windows)
source venv/bin/activate
pip install -r requirements.txt --quiet
cd ..

# Install frontend dependencies
echo "[2/4] Installing frontend dependencies..."
cd frontend
npm install --silent
cd ..

# Start Python backend
echo "[3/4] Starting Python backend (port 8000)..."
cd backend
source venv/bin/activate
python3 main.py &
BACKEND_PID=$!
cd ..

# Wait a moment for backend to start
sleep 3

# Start Electron frontend
echo "[4/4] Starting Electron frontend..."
cd frontend
npm run dev

# When frontend closes, cleanup
echo ""
echo "Shutting down..."
kill $BACKEND_PID 2>/dev/null

echo "Done."
