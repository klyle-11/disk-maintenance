@echo off
REM ============================================
REM Disk Intelligence - Quick Dev Launcher
REM ============================================
REM Assumes dependencies are already installed.
REM Use run.bat for first-time setup.
REM ============================================

cd /d "%~dp0\frontend"
echo Starting Disk Intelligence (dev mode)...
call npm run dev
