"""Filesystem layout for an installed Investment Dashboard."""

from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "InvestmentDashboard"
APP_DISPLAY_NAME = "Investment Dashboard"
PROJECT_NAME = "investment-dashboard"
LAUNCHER_FILENAME = "launcher.py"
VERSION_STATE_FILENAME = "installed_version.txt"


def default_install_root() -> Path:
    """Return the per-user install root.

    Uses ``%LOCALAPPDATA%\\InvestmentDashboard`` on Windows (no admin rights
    required) and ``~/.local/share/InvestmentDashboard`` elsewhere — which
    keeps the unit tests cross-platform.
    """
    override = os.environ.get("INV_DASHBOARD_INSTALL_ROOT")
    if override:
        return Path(override)

    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_NAME

    return Path.home() / ".local" / "share" / APP_NAME


def python_dir(install_root: Path) -> Path:
    return install_root / "python"


def python_executable(install_root: Path) -> Path:
    """Path to the embedded Python interpreter inside ``install_root``."""
    if os.name == "nt":
        return python_dir(install_root) / "python.exe"
    return python_dir(install_root) / "bin" / "python"


def pythonw_executable(install_root: Path) -> Path:
    """Path to the windowless interpreter (``pythonw.exe``).

    Falls back to the console interpreter on non-Windows hosts so tests can
    still exercise the path logic.
    """
    if os.name == "nt":
        return python_dir(install_root) / "pythonw.exe"
    return python_executable(install_root)


def launcher_path(install_root: Path) -> Path:
    return install_root / LAUNCHER_FILENAME


def version_state_path(install_root: Path) -> Path:
    return install_root / VERSION_STATE_FILENAME
