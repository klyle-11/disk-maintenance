@echo off
REM ============================================
REM Disk Intelligence - Application Launcher
REM ============================================
REM This script starts both the Python backend
REM and the Electron frontend.
REM ============================================

echo ============================================
echo    Disk Intelligence - Starting...
echo ============================================
echo.

REM Check if Python is available
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python 3.10+ from https://www.python.org/
    pause
    exit /b 1
)

REM Check if Node.js is available
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo [1/4] Installing backend dependencies...
cd backend
if not exist "venv" (
    python -m venv venv
)
call venv\Scripts\activate.bat
pip install -r requirements.txt --quiet
cd ..

echo [2/4] Installing frontend dependencies...
cd frontend
call npm install --silent
cd ..

echo [3/4] Starting Python backend (port 8000)...
start "Disk Intelligence - Backend" cmd /c "cd backend && call venv\Scripts\activate.bat && python main.py"

REM Wait a moment for backend to start
timeout /t 3 /nobreak >nul

echo [4/4] Starting Electron frontend...
cd frontend
call npm run dev

REM When frontend closes, cleanup
echo.
echo Shutting down...
taskkill /FI "WINDOWTITLE eq Disk Intelligence - Backend*" /F >nul 2>&1

echo Done.
pause
