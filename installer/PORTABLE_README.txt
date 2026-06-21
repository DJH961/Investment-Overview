Investment Dashboard - Portable bundle
======================================

This ZIP is a fully self-contained copy of the Investment Dashboard. It is
designed for locked-down work laptops where you cannot install software,
do not have administrator rights, and where Windows SmartScreen blocks
unsigned ".exe" installers from unknown developers.

How to use it
-------------
1. Right-click ``InvestmentDashboard-Portable.zip`` -> "Extract All...".
   Pick any folder you can write to (e.g. ``%USERPROFILE%\InvestmentDashboard``
   or a folder on your OneDrive).
2. Double-click ``Run-InvestmentDashboard.cmd`` inside the extracted
   folder. A console window will briefly appear and the dashboard will
   open in your default browser at http://localhost:8080.
3. To stop the dashboard, close the ``pythonw.exe`` task from the system
   tray, or simply close the browser tab and end the ``pythonw.exe``
   process from Task Manager. You can re-run ``Run-InvestmentDashboard.cmd``
   at any time.

What is in the bundle
---------------------
- ``python\`` - CPython 3.12 embeddable runtime (no system install
  required).
- ``portable_launcher.py`` - tiny Python entry-point that imports and
  runs the dashboard.
- ``Run-InvestmentDashboard.cmd`` - the file you double-click; it just
  launches ``python\pythonw.exe portable_launcher.py``.
- The ``investment_dashboard`` package and all of its runtime
  dependencies, pre-installed into ``python\Lib\site-packages\``.

Why this bypasses common work-laptop blockers
---------------------------------------------
- ``.cmd`` scripts are not subject to the SmartScreen "Unknown publisher"
  warning that blocks unsigned ``.exe`` files.
- Everything lives in the folder you extracted to, so no installer ever
  runs and no admin elevation is requested.
- Startup performs no network calls, so corporate proxies that block
  ``api.github.com`` (the cause of the earlier ``HTTP Error 404`` in the
  ``InvestmentDashboard-Setup.exe`` installer) do not affect the
  portable bundle.

Updating to a new version
-------------------------
Download the latest ``InvestmentDashboard-Portable.zip`` from
https://github.com/DJH961/Investment-Overview/releases/latest and extract
it on top of (or alongside) your existing folder. Your data lives in
``%LOCALAPPDATA%\InvestmentDashboard`` (or the path you configured via
``INV_DASHBOARD_*`` environment variables) and is not touched by the
upgrade.

If it does not start
--------------------
The launcher runs with no console window, so if a launch fails it leaves a
trail instead of vanishing silently:
- ``launcher.log`` (next to ``Run-InvestmentDashboard.cmd``) captures the
  launcher's own output and any startup traceback.
- ``logs\dashboard.log`` under your data folder captures the running app's
  log (relocatable via ``INV_DASHBOARD_LOG_DIR``).
Open the Data Health page in the app (or its "Download support bundle"
button) to package these logs when reporting an issue. Background refreshes
that fail are also shown in-app as a toast and on Data Health.
