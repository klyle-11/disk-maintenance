@echo off
rem di - Disk Intelligence command line (Windows).
rem Put this folder on your PATH, or copy/link di.cmd somewhere that is.
setlocal
set "ROOT=%~dp0"
set "PYTHONPATH=%ROOT%backend;%PYTHONPATH%"
set "PYTHONUTF8=1"

if defined DI_PYTHON (
  "%DI_PYTHON%" -m diskcli %*
  exit /b %ERRORLEVEL%
)
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 -m diskcli %*
  exit /b %ERRORLEVEL%
)
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python -m diskcli %*
  exit /b %ERRORLEVEL%
)
echo di: no Python 3 found. Install it from python.org or set DI_PYTHON. 1>&2
exit /b 127
