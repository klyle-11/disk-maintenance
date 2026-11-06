@echo off
REM ============================================
REM Disk Intelligence - Application Launcher
REM ============================================
REM Installs frontend dependencies and starts the
REM Tauri app in development mode. Needs Node.js
REM and Rust; no Python.
REM ============================================

cd /d "%~dp0"

echo ============================================
echo    Disk Intelligence - Starting...
echo ============================================
echo.

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

where cargo >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Rust is not installed or not in PATH
    echo Please install Rust from https://rustup.rs/
    pause
    exit /b 1
)

echo [1/2] Installing frontend dependencies...
cd frontend
call npm install --silent

echo [2/2] Starting Disk Intelligence (the first run compiles the Rust core)...
call npm run dev
pause
