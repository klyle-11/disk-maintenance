@echo off
REM ============================================
REM Disk Intelligence - Quick Dev Launcher
REM ============================================
REM Assumes dependencies are already installed.
REM Use run.bat for first-time setup.
REM ============================================

echo Starting Disk Intelligence (dev mode)...
echo.

echo [1/2] Starting Python backend (port 8000)...
start "Disk Intelligence - Backend" cmd /c "cd backend && call venv\Scripts\activate.bat && python main.py"

timeout /t 2 /nobreak >nul

echo [2/2] Starting Electron frontend...
cd frontend
call npm run dev

taskkill /FI "WINDOWTITLE eq Disk Intelligence - Backend*" /F >nul 2>&1
