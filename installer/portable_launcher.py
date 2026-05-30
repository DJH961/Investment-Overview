"""Self-contained launcher for the **portable** Investment Dashboard bundle.

The portable distribution (``InvestmentDashboard-Portable.zip``) ships an
embeddable CPython 3.12 interpreter and a pre-installed copy of the
``investment_dashboard`` wheel inside the unzipped folder. This script
sits next to ``python\\pythonw.exe`` and is launched by the bundled
``Run-InvestmentDashboard.cmd``.

Unlike the steady-state ``installer/launcher.py`` used by the one-file
``.exe`` installer, this launcher:

* makes **no** assumption about ``%LOCALAPPDATA%`` — everything lives in
  the unzipped folder, so the bundle can be carried on a USB stick or
  copied into a OneDrive folder on a work laptop;
* performs **no** network calls at startup — the portable bundle is
  fully self-contained, which avoids corporate-proxy / SmartScreen
  surprises and lets the dashboard start offline;
* depends only on the standard library and the bundled wheel, so the
  ``installer`` Python package does not need to be on ``sys.path``.

If the user wants self-update behaviour they can re-download the latest
portable ZIP from the GitHub Releases page.
"""

from __future__ import annotations

import contextlib
import datetime
import os
import platform
import sys
import traceback
from pathlib import Path
from typing import Any

#: Mirror all output here (next to this script in the portable folder) because
#: ``Run-InvestmentDashboard.cmd`` starts this launcher with ``pythonw.exe``,
#: which has no console: without a log file every error vanishes and a broken
#: bundle looks like it simply "does nothing". Set
#: ``INV_DASHBOARD_LAUNCHER_DEBUG=1`` to raise the dashboard log level.
LAUNCHER_LOG_FILENAME = "launcher.log"
_LOG_MAX_BYTES = 1_000_000
_DEBUG_ENV = "INV_DASHBOARD_LAUNCHER_DEBUG"
_ORIGINAL_STDOUT = sys.stdout
_ORIGINAL_STDERR = sys.stderr


class _Tee:
    """Write-only stream that fans output to the log file and any console."""

    def __init__(self, *sinks: Any) -> None:
        self._sinks = [sink for sink in sinks if sink is not None]

    def write(self, data: str) -> int:
        for sink in self._sinks:
            with contextlib.suppress(Exception):
                sink.write(data)
        return len(data)

    def flush(self) -> None:
        for sink in self._sinks:
            with contextlib.suppress(Exception):
                sink.flush()

    def isatty(self) -> bool:
        return False


def bundle_root() -> Path:
    """Folder that holds this portable launcher (and the bundled interpreter)."""
    return Path(__file__).resolve().parent


def _open_log_stream(root: Path) -> Any | None:
    """Open (and size-cap) ``<root>/launcher.log``. Returns ``None`` on failure."""
    try:
        path = root / LAUNCHER_LOG_FILENAME
        with contextlib.suppress(OSError):
            if path.exists() and path.stat().st_size > _LOG_MAX_BYTES:
                path.unlink()
        # Line-buffered so a hard crash still flushes the most recent lines.
        return open(path, "a", encoding="utf-8", buffering=1)
    except OSError:
        return None


def install_diagnostics(root: Path) -> Any | None:
    """Redirect stdout/stderr to ``<root>/launcher.log`` and log the environment."""
    stream = _open_log_stream(root)
    if stream is None:
        return None
    sys.stdout = _Tee(stream, _ORIGINAL_STDOUT)
    sys.stderr = _Tee(stream, _ORIGINAL_STDERR)
    if os.environ.get(_DEBUG_ENV):
        os.environ.setdefault("INV_DASHBOARD_LOG_LEVEL", "DEBUG")
    with contextlib.suppress(Exception):
        stamp = datetime.datetime.now().isoformat(timespec="seconds")
        print("=" * 72, flush=True)
        print(f"Investment Dashboard portable launcher started {stamp}", flush=True)
        print(f"  bundle root       : {root}", flush=True)
        print(f"  python executable : {sys.executable}", flush=True)
        print(f"  python version    : {sys.version.splitlines()[0]}", flush=True)
        print(f"  platform          : {platform.platform()}", flush=True)
        print(f"  cwd               : {os.getcwd()}", flush=True)
        print("=" * 72, flush=True)
    return stream


def main() -> int:
    log_stream = install_diagnostics(bundle_root())
    try:
        try:
            from investment_dashboard.main import run  # noqa: PLC0415
        except Exception:
            traceback.print_exc()
            print(
                "\nInvestment Dashboard is not installed in this portable bundle.\n"
                "Try re-downloading InvestmentDashboard-Portable.zip from the\n"
                "GitHub Releases page and extracting it again.",
                file=sys.stderr,
            )
            return 1
        try:
            run()
        except Exception:
            print("The dashboard crashed while starting:", flush=True)
            traceback.print_exc()
            return 1
        return 0
    finally:
        if log_stream is not None:
            with contextlib.suppress(Exception):
                log_stream.flush()


if __name__ in {"__main__", "__mp_main__"}:
    sys.exit(main())
