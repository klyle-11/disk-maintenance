@echo off
REM Start only the Python backend
cd backend
call venv\Scripts\activate.bat
echo Starting Disk Intelligence Backend on http://127.0.0.1:8000
echo Press Ctrl+C to stop.
echo.
python main.py
