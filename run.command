#!/bin/bash

# ============================================================
# Disk Intelligence - Application Launcher (macOS/Linux)
# ============================================================
# Installs frontend dependencies and starts the Tauri app in
# development mode. Needs Node.js and Rust; no Python.
# ============================================================

cd "$(dirname "$0")"

echo "============================================"
echo "   Disk Intelligence - Starting..."
echo "============================================"
echo ""

if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed or not in PATH"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

if ! command -v cargo &> /dev/null; then
    echo "ERROR: Rust is not installed or not in PATH"
    echo "Please install Rust from https://rustup.rs/"
    exit 1
fi

echo "[1/2] Installing frontend dependencies..."
cd frontend
npm install --silent

echo "[2/2] Starting Disk Intelligence (the first run compiles the Rust core)..."
npm run dev
