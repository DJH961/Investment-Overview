"""Steady-state launcher for an installed Investment Dashboard.

This script sits at ``%LOCALAPPDATA%\\InvestmentDashboard\\launcher.py`` after
the bootstrapper finishes. The Start-menu / Desktop shortcut points
``pythonw.exe`` at this file, so the user just double-clicks the shortcut.

Responsibilities, in order:

1. Read the currently-installed dashboard version (``importlib.metadata``).
2. Ask GitHub for the latest release tag (network failures are non-fatal —
   we just skip the update check and start the app).
3. If a newer release is available, run ``pip install --upgrade`` against
   the release's wheel (or the source tarball if no wheel is published).
4. Hand off to ``investment_dashboard.main.run`` to start the NiceGUI app.

The launcher is plain Python — it is **not** frozen by PyInstaller, so it
can be replaced wholesale by a future release if the update flow ever
needs to change.
"""

from __future__ import annotations

import contextlib
import importlib.metadata as importlib_metadata
import json
import os
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

# Allow running this file directly (``python launcher.py``) by ensuring its
# parent directory — which contains the ``installer`` package when shipped —
# is importable. When the file is run from inside the installed layout the
# package is already on ``sys.path`` via the bootstrapper.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR.parent))

from installer.paths import (  # noqa: E402
    PROJECT_NAME,
    default_install_root,
    python_executable,
    version_state_path,
)
from installer.version import (  # noqa: E402
    LATEST_RELEASE_API,
    USER_AGENT,
    extract_release_metadata,
    is_newer,
    tarball_url,
)

NETWORK_TIMEOUT_SECONDS = 10
_SKIP_UPDATE_ENV = "INV_DASHBOARD_SKIP_UPDATE_CHECK"


def installed_version() -> str | None:
    """Return the installed dashboard version, or ``None`` if not installed."""
    try:
        return importlib_metadata.version(PROJECT_NAME)
    except importlib_metadata.PackageNotFoundError:
        return None


def fetch_latest_release(url: str = LATEST_RELEASE_API) -> dict[str, Any] | None:
    """Hit the GitHub Releases API. Return ``None`` on any network failure."""
    request = Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    )
    try:
        with urlopen(request, timeout=NETWORK_TIMEOUT_SECONDS) as response:
            raw = response.read().decode("utf-8")
    except (URLError, TimeoutError, OSError):
        return None

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data


def pip_install_target(tag: str, wheel_url: str | None) -> str:
    """Return the URL ``pip install`` should fetch for ``tag``."""
    return wheel_url if wheel_url else tarball_url(tag)


def run_pip_install(python_exe: Path, target: str) -> None:
    """Run ``python -m pip install --upgrade <target>`` against ``python_exe``."""
    subprocess.check_call(
        [str(python_exe), "-m", "pip", "install", "--upgrade", target],
    )


def record_installed_version(install_root: Path, version: str) -> None:
    """Persist the just-installed version so first-launch diagnostics work."""
    state = version_state_path(install_root)
    with contextlib.suppress(OSError):
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(version, encoding="utf-8")


def maybe_update(install_root: Path) -> str | None:
    """Best-effort self-update. Returns the new version when one was installed.

    Never raises: a failed update should not block the dashboard from starting.
    """
    if os.environ.get(_SKIP_UPDATE_ENV):
        return None

    current = installed_version()
    payload = fetch_latest_release()
    if payload is None:
        return None

    try:
        tag, wheel_url = extract_release_metadata(payload)
    except ValueError:
        return None

    if current is not None and not is_newer(tag, current):
        return None

    target = pip_install_target(tag, wheel_url)
    print(
        f"Updating Investment Dashboard {current or '(none)'} -> {tag} from {target} ...",
        flush=True,
    )
    try:
        run_pip_install(python_executable(install_root), target)
    except (subprocess.CalledProcessError, OSError) as exc:
        print(f"Update failed ({exc!r}); continuing with the installed version.", flush=True)
        return None

    record_installed_version(install_root, tag)
    return tag


def start_dashboard() -> int:
    """Import and run the dashboard. Returns the process exit code."""
    try:
        from investment_dashboard.main import run  # noqa: PLC0415
    except ImportError:
        traceback.print_exc()
        return 1
    run()
    return 0


def main() -> int:
    install_root = default_install_root()
    try:
        maybe_update(install_root)
    except Exception:
        traceback.print_exc()
    return start_dashboard()


if __name__ in {"__main__", "__mp_main__"}:
    sys.exit(main())
