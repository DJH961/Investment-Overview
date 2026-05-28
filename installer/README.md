# Investment Dashboard — Windows installer & portable bundle

This directory produces two end-user artefacts that the release pipeline
publishes alongside the wheel/sdist on every `v*` tag:

| Artefact | When to use it |
|---|---|
| **`InvestmentDashboard-Setup.exe`** | Personal Windows PC where SmartScreen is OK and `api.github.com` is reachable. Smallest download. Self-updates on every launch. |
| **`InvestmentDashboard-Portable.zip`** | Work laptops where SmartScreen blocks unsigned `.exe`s, where you do not have admin rights, or where the corporate proxy blocks `api.github.com`. Fully offline, no installation, just `Extract All…` and double-click the `.cmd`. |

## What the user sees — `.exe` installer

1. They download a single `InvestmentDashboard-Setup.exe` from the
   [Releases page][releases].
2. They double-click it. A console window opens, shows a short progress
   log (downloading Python, installing the dashboard), and then the
   dashboard browser tab appears automatically.
3. On every subsequent launch — via the Start-menu / Desktop shortcut the
   installer created — the launcher checks GitHub for a newer release
   and silently upgrades the local install before starting the app.

[releases]: https://github.com/DJH961/Investment-Overview/releases/latest

## What the user sees — portable bundle

1. They download `InvestmentDashboard-Portable.zip` from the same
   Releases page.
2. They right-click it → *Extract All…* into any writable folder.
3. They double-click `Run Investment Dashboard.cmd` inside the extracted
   folder. The dashboard opens in their default browser.

No installer runs, no shortcuts are created, no internet connection is
required at launch time, and Windows does not show a SmartScreen prompt
because `.cmd` scripts are not subject to the unsigned-`.exe` block.
Upgrading is a matter of re-extracting the newer ZIP.

## What the `.exe` actually contains

`InvestmentDashboard-Setup.exe` is a PyInstaller one-file build of just
**`bootstrap.py`** plus the four small `installer/*.py` source files. It
contains **no embedded Python and no dashboard wheel** — those are
fetched from python.org and GitHub at install time.

Consequence: the same `.exe` works for every future v2.x release. It only
needs to be rebuilt if:

- the bootstrap logic itself changes, or
- `EMBED_PYTHON_VERSION` in `installer/bootstrap.py` is bumped past the
  user's host capabilities.

### Resilience against blocked `api.github.com`

`installer/version.py::resolve_latest_release` tries the GitHub JSON API
first and **falls back to the public
`https://github.com/<repo>/releases/latest` redirect** when the API is
unreachable. Many corporate networks whitelist `github.com` for code
checkout but block the `api.github.com` subdomain entirely, which used
to surface as `urllib.error.HTTPError: HTTP Error 404: Not Found` deep
inside the bootstrapper. The fallback parses the final redirect URL
(`…/releases/tag/<tag>`) for the tag and predicts the wheel asset URL
from it; the installer then `pip install`s that URL directly, falling
back further to the auto-generated source tarball if the predicted
wheel is missing.

## What the portable bundle contains

`InvestmentDashboard-Portable.zip` ships everything needed to run the
dashboard on a fresh Windows machine with **no network access**:

- `python\` — the CPython 3.12 embeddable runtime, with `import site`
  enabled and `pip` bootstrapped.
- `python\Lib\site-packages\` — the `investment_dashboard` wheel and
  all of its runtime dependencies, pre-installed at release-build time.
- `portable_launcher.py` — a tiny entry-point that imports and runs
  `investment_dashboard.main.run` (see source for the rationale).
- `Run Investment Dashboard.cmd` — the double-click target. It launches
  `python\pythonw.exe portable_launcher.py` from the bundle root.
- `README.txt` — a copy of `installer/PORTABLE_README.txt` aimed at the
  end user.

## How releases are wired up

`.github/workflows/release.yml` runs on every `v*` tag push (or via
`workflow_dispatch`). It:

1. Builds the dashboard wheel + sdist with `python -m build`.
2. Builds `InvestmentDashboard-Setup.exe` on a `windows-2022` runner
   using `installer/installer.spec`. The runner is pinned to
   `windows-2022` (rather than `windows-latest`) because PyInstaller
   bundles the build machine's Universal C Runtime, and the UCRT shipped
   on Windows Server 2025 — to which `windows-latest` now resolves — is
   incompatible with Windows 10 / 11 client SKUs and produces a
   `ucrtbase.dll` "Bad Image" dialog (`Error status 0xc0e90002`) on
   end-user machines.
3. Builds `InvestmentDashboard-Portable.zip` on the same pinned runner
   by downloading the embeddable Python, enabling `site`, bootstrapping
   `pip`, installing the freshly built wheel, and zipping the resulting
   folder together with `portable_launcher.py` and the `.cmd` script.
4. Publishes a GitHub Release for the tag and attaches all four
   artefacts.

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
update-decision logic, the `resolve_latest_release` resolver and its
redirect fallback) are covered by `tests/installer/`. Run them with
the standard project command:

```
python -m pytest -q tests/installer
```

