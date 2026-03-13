#!/bin/bash

echo "============================================"
echo "   Disk Intelligence - Starting..."
echo "============================================"
echo ""

if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed or not in PATH"
    echo "Please install Python 3.10+ from https://www.python.org/"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed or not in PATH"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

echo "[1/4] Installing backend dependencies..."
cd backend
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

source venv/bin/activate
pip install -r requirements.txt --quiet
cd ..

echo "[2/4] Installing frontend dependencies..."
cd frontend
npm install --silent
cd ..

echo "[3/4] Starting Python backend (port 8000)..."
cd backend
source venv/bin/activate
python3 main.py &
BACKEND_PID=$!
cd ..

sleep 3

echo "[4/4] Starting Electron frontend..."
cd frontend
npm run dev

echo ""
echo "Shutting down..."
kill $BACKEND_PID 2>/dev/null

echo "Done."
