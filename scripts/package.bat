@echo off
REM Full build and package for Windows
REM Creates an installable .exe in the release/ directory
REM Run from the project root: scripts\package.bat

echo ============================================
echo  Packaging Disk Intelligence for Windows
echo ============================================
echo.

REM Step 1: Build the Python backend
echo [Step 1/3] Building Python backend...
call "%~dp0\build-backend.bat"
if errorlevel 1 (
    echo ERROR: Backend build failed
    exit /b 1
)

REM Step 2: Install frontend dependencies
echo.
echo [Step 2/3] Installing frontend dependencies...
cd /d "%~dp0\..\frontend"
call npm install

REM Step 3: Build frontend and create Electron installer
echo.
echo [Step 3/3] Building frontend and creating installer...
call npm run dist:win

echo.
echo ============================================
if exist "..\release\*.exe" (
    echo  SUCCESS! Installer created in release\
    dir /b "..\release\*.exe"
) else (
    echo  Build completed. Check release\ for output.
)
echo ============================================
