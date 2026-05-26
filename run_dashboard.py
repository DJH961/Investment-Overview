"""Double-clickable launcher for the Investment Dashboard.

Run with no command-line arguments. This file is the entry point a user
would put on the desktop or in a Windows Startup folder.

On first run it creates ``.venv`` and installs the project dependencies,
then re-launches itself with the virtualenv Python before importing the
application. If anything fails before the server starts, the exception is
printed and the window stays open until the user presses Enter.
"""

from __future__ import annotations

import contextlib
import importlib.metadata as importlib_metadata
import importlib.util
import os
import subprocess
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MIN_PYTHON = (3, 12)
MIN_NICEGUI = (2, 10, 0)
MAX_NICEGUI = (3, 0, 0)
VENV_DIR = ROOT / ".venv"
VENV_PYTHON = VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
REQUIRED_MODULES = (
    "alembic",
    "dateutil",
    "httpx",
    "nicegui",
    "numpy",
    "pandas",
    "plotly",
    "pydantic",
    "pydantic_settings",
    "scipy",
    "pytest",
    "sqlalchemy",
    "yfinance",
)


def _ensure_src_on_path() -> None:
    src = ROOT / "src"
    if src.exists() and str(src) not in sys.path:
        sys.path.insert(0, str(src))


def _run_checked(args: list[str], step: str) -> None:
    try:
        subprocess.check_call(args, cwd=ROOT)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"{step} failed with exit code {exc.returncode}.") from exc


def _is_running_from_venv() -> bool:
    try:
        return Path(sys.executable).resolve() == VENV_PYTHON.resolve()
    except OSError:
        return False


def _current_python_has_dependencies() -> bool:
    return (
        all(importlib.util.find_spec(module) is not None for module in REQUIRED_MODULES)
        and _nicegui_is_supported()
    )


def _version_tuple(version: str) -> tuple[int, int, int]:
    parts: list[int] = []
    for token in version.replace("-", ".").split("."):
        number = ""
        for char in token:
            if not char.isdigit():
                break
            number += char
        if number:
            parts.append(int(number))
        if len(parts) == 3:
            break

    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def _nicegui_is_supported() -> bool:
    try:
        version = importlib_metadata.version("nicegui")
    except importlib_metadata.PackageNotFoundError:
        return False
    parsed = _version_tuple(version)
    return MIN_NICEGUI <= parsed < MAX_NICEGUI


def _venv_has_dependencies() -> bool:
    if not VENV_PYTHON.exists():
        return False

    code = "import run_dashboard, sys; sys.exit(0 if run_dashboard._current_python_has_dependencies() else 1)"
    return subprocess.run([str(VENV_PYTHON), "-c", code], cwd=ROOT, check=False).returncode == 0


def _ensure_supported_python() -> None:
    if sys.version_info < MIN_PYTHON:
        required = ".".join(str(part) for part in MIN_PYTHON)
        current = ".".join(str(part) for part in sys.version_info[:3])
        raise RuntimeError(f"Python {required}+ is required; found Python {current}.")


def _ensure_venv_ready() -> None:
    if not VENV_PYTHON.exists():
        print(f"Creating virtual environment in {VENV_DIR.name} ...", flush=True)
        _run_checked([sys.executable, "-m", "venv", str(VENV_DIR)], "Virtual environment creation")

    if not _venv_has_dependencies():
        print(
            "Installing investment-dashboard and dependencies (one-time, about a minute) ...",
            flush=True,
        )
        _run_checked([str(VENV_PYTHON), "-m", "pip", "install", "--upgrade", "pip"], "pip upgrade")
        _run_checked([str(VENV_PYTHON), "-m", "pip", "install", "-e", "."], "Dependency install")
        _run_checked(
            [str(VENV_PYTHON), "-m", "pip", "install", "pytest"],
            "Pytest install",
        )


def _relaunch_from_venv_if_needed() -> None:
    if _is_running_from_venv() and _current_python_has_dependencies():
        return

    _ensure_venv_ready()
    if not _venv_has_dependencies():
        raise RuntimeError("The virtual environment is missing required dependencies after setup.")
    if not _is_running_from_venv() or not _current_python_has_dependencies():
        os.execv(
            str(VENV_PYTHON), [str(VENV_PYTHON), str(ROOT / "run_dashboard.py"), *sys.argv[1:]]
        )


def main() -> int:
    try:
        _ensure_supported_python()
        _relaunch_from_venv_if_needed()
        _ensure_src_on_path()
        from investment_dashboard.main import run  # noqa: PLC0415

        run()
    except KeyboardInterrupt:
        print("\nDashboard stopped (Ctrl+C).")
        return 0
    except Exception:
        traceback.print_exc()
        with contextlib.suppress(EOFError):
            input("\nPress Enter to close…")
        return 1
    return 0


if __name__ in {"__main__", "__mp_main__"}:
    sys.exit(main())
