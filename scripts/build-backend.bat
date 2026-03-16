@echo off
REM Build the Python backend into a standalone executable using PyInstaller
REM Run from the project root: scripts\build-backend.bat

echo ============================================
echo  Building Disk Intelligence Backend
echo ============================================

cd /d "%~dp0\..\backend"

REM Check if Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH
    exit /b 1
)

REM Install PyInstaller if not present
pip show pyinstaller >nul 2>&1
if errorlevel 1 (
    echo Installing PyInstaller...
    pip install pyinstaller
)

REM Install backend dependencies
echo Installing backend dependencies...
pip install -r requirements.txt

REM Clean previous build
if exist "dist" rmdir /s /q dist
if exist "build" rmdir /s /q build

REM Set the du-hast-much path
set DU_HAST_MUCH_PATH=%~dp0\..\..\du-hast-much

REM Run PyInstaller
echo Running PyInstaller...
pyinstaller disk-intelligence.spec --clean

echo.
if exist "dist\disk-intelligence-backend.exe" (
    echo SUCCESS: Backend built at backend\dist\disk-intelligence-backend.exe
) else (
    echo ERROR: Build failed - executable not found
    exit /b 1
)
