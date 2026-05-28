# Investment Dashboard — single-file Windows installer

This directory produces **`InvestmentDashboard-Setup.exe`**, the one-file
installer mentioned in the project root README.

## What the user sees

1. They download a single `InvestmentDashboard-Setup.exe` from the
   [Releases page][releases].
2. They double-click it. A console window opens, shows a short progress
   log (downloading Python, installing the dashboard), and then the
   dashboard browser tab appears automatically.
3. On every subsequent launch — via the Start-menu / Desktop shortcut the
   installer created — the launcher checks GitHub for a newer release
   and silently upgrades the local install before starting the app.

[releases]: https://github.com/DJH961/Investment-Overview/releases/latest

## What the `.exe` actually contains

`InvestmentDashboard-Setup.exe` is a PyInstaller one-file build of just
**`bootstrap.py`** plus the four small `installer/*.py` source files. It
contains **no embedded Python and no dashboard wheel** — those are
fetched from python.org and the GitHub Releases API at install time.

Consequence: the same `.exe` works for every future v2.x release. It only
needs to be rebuilt if:

- the bootstrap logic itself changes, or
- `EMBED_PYTHON_VERSION` in `installer/bootstrap.py` is bumped past the
  user's host capabilities.

## How releases are wired up

`.github/workflows/release.yml` runs on every `v*` tag push (or via
`workflow_dispatch`). It:

1. Builds the dashboard wheel + sdist with `python -m build`.
2. Builds `InvestmentDashboard-Setup.exe` on a `windows-latest` runner
   using `installer/installer.spec`.
3. Publishes a GitHub Release for the tag and attaches all three
   artifacts.

Because the launcher prefers a wheel asset and falls back to the
GitHub-generated source tarball, the installer keeps working even if the
release workflow fails to attach a wheel.

## Building the installer locally (Windows only)

```powershell
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install pyinstaller build
pyinstaller --clean --noconfirm installer\installer.spec
# -> dist\InvestmentDashboard-Setup.exe
```

## Testing the helper modules

The pure-Python helpers (`installer/version.py`, the launcher's
update-decision logic) are covered by `tests/installer/`. Run them with
the standard project command:

```
python -m pytest -q tests/installer
```
