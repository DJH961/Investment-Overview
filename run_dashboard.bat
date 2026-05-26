@echo off
REM Double-clickable launcher for the Investment Dashboard (Windows).
REM
REM First run setup is handled by run_dashboard.py, which creates .venv and
REM installs dependencies if needed. Subsequent runs reuse that environment.
REM
REM Requires Python 3.12+ on PATH (`py -3.12 --version` will be tried first,
REM then `python`).

setlocal enableextensions
cd /d "%~dp0"

set "PY_EXE="

REM Prefer the Windows py launcher targeting 3.12+, fall back to plain python.
for %%P in ("py -3.12" "py -3.13" "py -3" "python") do (
    %%~P -c "import sys;sys.exit(0 if sys.version_info>=(3,12) else 1)" >nul 2>&1
    if not errorlevel 1 (
        set "PY_EXE=%%~P"
        goto :have_python
    )
)

echo Python 3.12+ was not found on PATH. Please install it from
echo https://www.python.org/downloads/ and re-run this script.
pause
exit /b 1

:have_python

echo Starting Investment Dashboard ...
%PY_EXE% "%~dp0run_dashboard.py"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
