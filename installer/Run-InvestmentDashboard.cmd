@echo off
REM ============================================================================
REM Investment Dashboard - portable launcher
REM ----------------------------------------------------------------------------
REM Double-click this file to start the dashboard. No installation, no admin
REM rights, no SmartScreen "unknown publisher" prompt -- a .cmd script is not
REM treated as an unsigned executable by Windows, so locked-down work laptops
REM let it run without intervention.
REM
REM The bundled embeddable CPython interpreter (in .\python\) launches the
REM portable_launcher.py script in the same folder, which imports and runs the
REM Investment Dashboard. Closing this window stops the dashboard.
REM ============================================================================

setlocal
cd /d "%~dp0"

if not exist "%~dp0python\pythonw.exe" (
    echo [ERROR] Bundled Python runtime not found at "%~dp0python\pythonw.exe".
    echo Please re-extract InvestmentDashboard-Portable.zip and try again.
    pause
    exit /b 1
)

REM Start the dashboard in a detached pythonw process so this console window
REM is only used to surface early errors. The browser tab opens automatically.
start "" "%~dp0python\pythonw.exe" "%~dp0portable_launcher.py"

REM Brief friendly message; the .cmd window can be closed safely once the
REM dashboard tab is up.
echo Investment Dashboard is starting in a new window.
echo You can close this window once the dashboard tab appears.
timeout /t 5 /nobreak >nul
endlocal
