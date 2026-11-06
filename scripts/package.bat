@echo off
REM Full build and package for Windows (Tauri)
REM Creates .msi and setup .exe installers under
REM frontend\src-tauri\target\release\bundle\
REM Run from the project root: scripts\package.bat

echo ============================================
echo  Packaging Disk Intelligence for Windows
echo ============================================
echo.

where cargo >nul 2>&1
if errorlevel 1 (
    echo ERROR: Rust is not installed. Get it from https://rustup.rs
    exit /b 1
)

echo [Step 1/2] Installing frontend dependencies...
cd /d "%~dp0\..\frontend"
call npm install

echo.
echo [Step 2/2] Building the app...
call npm run dist
if errorlevel 1 (
    echo ERROR: Build failed
    exit /b 1
)

echo.
echo ============================================
echo  SUCCESS! See frontend\src-tauri\target\release\bundle\
echo ============================================
