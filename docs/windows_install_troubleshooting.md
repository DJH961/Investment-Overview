# Windows installer / "installs but never runs" — diagnostics & test plan

This document explains **why** the installed program can appear to do nothing
after a successful install, **what we changed** so the failure now leaves a
diagnosable trail, and **how to bug-test it** and report back.

You do not need to read any code to follow the test steps — jump to
[How to bug-test](#how-to-bug-test).

---

## The symptom

The installer (`InvestmentDashboard-Setup.exe`) or the portable bundle
finishes without an obvious error, but the dashboard window/tab never opens.
Nothing visible happens, and there is no error message to act on.

## Why this happens (root cause)

The Start-menu / Desktop shortcut (and the portable `.cmd`) start the program
with **`pythonw.exe`**, which is the *windowless* Python interpreter. It has
**no console**, which means:

1. **All output and error messages are thrown away.** `pythonw.exe` sets
   `stdout`/`stderr` to nothing. Anything the launcher, `pip`, or the web
   framework (NiceGUI/uvicorn) prints — including a full crash traceback — is
   silently discarded. So a real crash looks identical to "nothing happened".
2. **Writing to the missing console could itself crash the app.** The web
   server prints a "ready" banner on startup. Writing that banner to a
   non-existent console can raise an error, which (because of point 1) also
   disappears. This alone can stop the program before the browser ever opens.
3. **Only one kind of error was being caught.** The previous launcher only
   handled a missing-dependency error. Other common, real-world failures —
   the chosen network **port (8080) already being in use**, a firewall block,
   a NiceGUI/uvicorn startup error — were not caught and killed the
   (invisible) process with no trace.

In short: the program may well have been failing for an ordinary, fixable
reason, but **there was no way to see what that reason was**.

## What we changed

We did **not** guess at a single fix. Instead we made every failure
*observable* so you can tell us exactly what goes wrong:

- **A log file is now written on every launch.** Both launchers
  (`installer/launcher.py` for the installed app and
  `installer/portable_launcher.py` for the portable bundle) now redirect all
  output to a `launcher.log` file and, when a console exists, also to the
  console.
  - Installed app: `%LOCALAPPDATA%\InvestmentDashboard\launcher.log`
  - Portable bundle: `launcher.log` next to `Run-InvestmentDashboard.cmd`
- **The log records the environment up front** — Python version and path,
  platform, install location, and the installed dashboard version — so we can
  spot a broken interpreter or a version mismatch at a glance.
- **Every startup failure is now caught and written with a full traceback**,
  including update-check failures, import failures, and crashes while the web
  server starts (e.g. the port-in-use case).
- **An optional debug switch:** setting the environment variable
  `INV_DASHBOARD_LAUNCHER_DEBUG=1` raises the app's log level to `DEBUG` for
  more detail.

The log is automatically trimmed if it grows past ~1 MB, so it will not pile
up over time.

---

## How to bug-test

Please run through these and send back what you find. The single most useful
artifact is the **`launcher.log` file** after a failed start.

### Test 1 — Reproduce and capture the log (most important)

1. Install/run the app exactly as before (the way that "never runs").
2. Wait ~15 seconds for it to fail.
3. Open this file in Notepad and **copy its entire contents back to us**:
   - Installed app: `%LOCALAPPDATA%\InvestmentDashboard\launcher.log`
     (paste that path into the Explorer address bar).
   - Portable bundle: the `launcher.log` next to `Run-InvestmentDashboard.cmd`.

**Why:** this captures the real, previously-invisible error. It tells us
whether the problem is the port, a missing dependency, the interpreter, the
database, or the web server — which determines the actual fix.

### Test 2 — Run with a visible console (see the error live)

If the log file is empty or missing, run the launcher with the **console**
interpreter so the window stays open and shows the error:

1. Open Command Prompt (`cmd.exe`).
2. Run (installed app):

   ```bat
   "%LOCALAPPDATA%\InvestmentDashboard\python\python.exe" "%LOCALAPPDATA%\InvestmentDashboard\launcher.py"
   ```

   Portable bundle — from the extracted folder:

   ```bat
   .\python\python.exe .\portable_launcher.py
   ```
3. **Copy everything the window prints** (especially the last 20–30 lines).

**Why:** `python.exe` (not `pythonw.exe`) keeps a console open, so even an
error that somehow escapes the log file is visible here. This distinguishes
"the app crashes" from "the shortcut is wrong".

### Test 3 — Is the port already in use? (a very common cause)

1. With the app *not* running, open Command Prompt and run:

   ```bat
   netstat -ano | findstr :8080
   ```
2. If that prints any lines, **port 8080 is already taken** by another
   program — that would stop the dashboard from starting.
3. Then try forcing a different port and launch again (Test 2):

   ```bat
   set INV_DASHBOARD_PORT=8099
   "%LOCALAPPDATA%\InvestmentDashboard\python\python.exe" "%LOCALAPPDATA%\InvestmentDashboard\launcher.py"
   ```
4. Tell us whether it starts on `http://localhost:8099`.

**Why:** if a different port fixes it, the default `8080` was the culprit and
we can change the default and/or auto-pick a free port.

### Test 4 — Did the browser just not open? (app may actually be running)

1. Start the app the normal way and wait ~15 seconds.
2. Open a browser manually and go to **http://localhost:8080**.
3. Tell us whether the dashboard loads there even though no window opened.

**Why:** this separates "the app failed to start" from "the app started but
the browser/tab failed to launch" — two different fixes.

### Test 5 — Extra detail (optional)

1. Open Command Prompt and run:

   ```bat
   set INV_DASHBOARD_LAUNCHER_DEBUG=1
   ```
2. Repeat Test 1 or Test 2 in that same window, then send the `launcher.log`.

**Why:** debug logging surfaces lower-level detail (database/boot steps) that
may matter if the failure is not in the obvious places.

---

## What to send back

- The full contents of **`launcher.log`** (Test 1) — top priority.
- Any text printed by the console run (Test 2).
- The result of the port check (Test 3) and the manual browser visit (Test 4).
- Your Windows version (e.g. Windows 10 22H2 / Windows 11) and whether the
  machine is a managed/work laptop (antivirus, proxy, or firewall can matter).

With the `launcher.log` in hand we can pinpoint the real cause and ship a
targeted fix instead of guessing.
