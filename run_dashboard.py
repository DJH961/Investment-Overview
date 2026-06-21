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
import json
import os
import re
import signal
import subprocess
import sys
import tomllib
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT_NAME = "investment-dashboard"
MIN_PYTHON = (3, 12)
# Installed versions of the runtime dependencies are validated at startup
# against the version pins declared in pyproject.toml, so an out-of-date package
# in an existing .venv can't silently run the app (the bug this guards against
# was a stale NiceGUI floor). The constants below are a last-resort safety net
# for NiceGUI (the most breakage-prone pin) used only when pyproject.toml itself
# can't be read or parsed; they need not track every pin bump.
FALLBACK_MIN_NICEGUI = (3, 12, 0)
FALLBACK_MAX_NICEGUI = (4, 0, 0)
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


def _venv_has_pip() -> bool:
    if not VENV_PYTHON.exists():
        return False
    return (
        subprocess.run(
            [str(VENV_PYTHON), "-m", "pip", "--version"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        ).returncode
        == 0
    )


def _ensure_venv_has_pip() -> None:
    if _venv_has_pip():
        return

    print(f"Bootstrapping pip in {VENV_DIR.name} ...", flush=True)
    _run_checked([str(VENV_PYTHON), "-m", "ensurepip", "--upgrade"], "pip bootstrap")


def _dashboard_port() -> int:
    raw_port = os.environ.get("INV_DASHBOARD_PORT", "8080")
    try:
        return int(raw_port)
    except ValueError:
        return 8080


def _existing_dashboard_process_ids() -> list[int]:
    if os.name != "nt":
        return []

    script = str((ROOT / "run_dashboard.py").resolve())
    command = r"""
$script = [System.IO.Path]::GetFullPath($env:INV_DASHBOARD_SCRIPT).ToLowerInvariant()
$scriptAlt = $script.Replace('\', '/')
$current = [int]$env:INV_DASHBOARD_CURRENT_PID
$port = [int]$env:INV_DASHBOARD_PORT_TO_STOP
$listenerIds = @(
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
)
Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe' OR Name = 'py.exe'" |
    Where-Object {
        $_.ProcessId -ne $current -and
        $listenerIds -contains $_.ProcessId -and
        $_.CommandLine -and
        ($_.CommandLine.ToLowerInvariant().Contains($script) -or
         $_.CommandLine.ToLowerInvariant().Contains($scriptAlt))
    } |
    Select-Object -ExpandProperty ProcessId
"""
    env = os.environ.copy()
    env["INV_DASHBOARD_SCRIPT"] = script
    env["INV_DASHBOARD_CURRENT_PID"] = str(os.getpid())
    env["INV_DASHBOARD_PORT_TO_STOP"] = str(_dashboard_port())
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        return []

    process_ids: list[int] = []
    for line in result.stdout.splitlines():
        with contextlib.suppress(ValueError):
            process_ids.append(int(line.strip()))
    return process_ids


def _terminate_process_tree(process_id: int) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill.exe", "/PID", str(process_id), "/T", "/F"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        return

    with contextlib.suppress(ProcessLookupError):
        os.kill(process_id, signal.SIGTERM)


def _stop_existing_dashboard_instances() -> None:
    process_ids = _existing_dashboard_process_ids()
    if not process_ids:
        return

    print(
        "Stopping existing Investment Dashboard instance before starting the current release ...",
        flush=True,
    )
    for process_id in process_ids:
        _terminate_process_tree(process_id)


def _is_running_from_venv() -> bool:
    try:
        return Path(sys.executable).resolve() == VENV_PYTHON.resolve()
    except OSError:
        return False


def _dependency_problems() -> list[str]:
    """Return human-readable reasons the current interpreter isn't ready, if any."""
    problems: list[str] = []

    missing = [m for m in REQUIRED_MODULES if importlib.util.find_spec(m) is None]
    if missing:
        problems.append(f"missing modules: {', '.join(sorted(missing))}")

    # Validate every runtime dependency's installed version against the pins in
    # pyproject.toml so version drift can't slip through for any package, not
    # just NiceGUI.
    for name, lower, upper in _pyproject_requirements():
        problem = _version_problem(name, lower, upper)
        if problem:
            problems.append(problem)

    if not _installed_project_is_current():
        try:
            installed = importlib_metadata.version(PROJECT_NAME)
        except importlib_metadata.PackageNotFoundError:
            installed = "not installed"
        problems.append(
            f"{PROJECT_NAME} {installed} does not match project version {_project_version()}"
        )

    return problems


def _current_python_has_dependencies() -> bool:
    return not _dependency_problems()


def _read_pyproject() -> dict:
    pyproject = ROOT / "pyproject.toml"
    try:
        return tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise RuntimeError(f"Unable to read {pyproject}.") from exc


def _project_version() -> str:
    pyproject = ROOT / "pyproject.toml"
    data = _read_pyproject()

    version = data.get("project", {}).get("version")
    if not isinstance(version, str) or not version:
        raise RuntimeError(f"Unable to read project version from {pyproject}.")
    return version


_Bound = tuple[int, int, int] | None


def _parse_requirement(entry: str) -> tuple[str, _Bound, _Bound] | None:
    """Parse a PEP 508 dependency string into (name, lower, exclusive upper).

    ``lower`` is the tightest ``>=``/``==``/``~=`` floor and ``upper`` the
    tightest ``<`` ceiling found; either may be ``None`` when unconstrained.
    ``~=`` is treated as a floor only (no ``~=`` pins are used today); this gate
    is a coarse minimum-version check, not a full PEP 440 evaluator.
    Returns ``None`` when no package name can be extracted.
    """
    name = re.split(r"[<>=!~;\s\[]", entry, maxsplit=1)[0].strip().lower().replace("_", "-")
    if not name:
        return None

    lower: _Bound = None
    upper: _Bound = None
    for operator, raw_version in re.findall(r"(>=|<=|==|~=|<|>)\s*([0-9]+(?:\.[0-9]+)*)", entry):
        version = _version_tuple(raw_version)
        if operator in {">=", "==", "~="}:
            lower = version if lower is None else max(lower, version)
        elif operator == "<":
            upper = version if upper is None else min(upper, version)
    return name, lower, upper


def _pyproject_requirements() -> list[tuple[str, _Bound, _Bound]]:
    """Parsed runtime dependencies from pyproject.toml (name + version bounds).

    Falls back to the NiceGUI safety-net bounds if pyproject.toml can't be read
    or parsed, so the most breakage-prone pin is still enforced.
    """
    try:
        dependencies = _read_pyproject().get("project", {}).get("dependencies", [])
    except RuntimeError:
        return [("nicegui", FALLBACK_MIN_NICEGUI, FALLBACK_MAX_NICEGUI)]

    requirements: list[tuple[str, _Bound, _Bound]] = []
    for entry in dependencies:
        if not isinstance(entry, str):
            continue
        parsed = _parse_requirement(entry)
        if parsed is not None:
            requirements.append(parsed)
    return requirements


def _format_bounds(lower: _Bound, upper: _Bound) -> str:
    parts: list[str] = []
    if lower is not None:
        parts.append(f">={'.'.join(map(str, lower))}")
    if upper is not None:
        parts.append(f"<{'.'.join(map(str, upper))}")
    return ",".join(parts) if parts else "any version"


def _version_problem(name: str, lower: _Bound, upper: _Bound) -> str | None:
    """Return a problem description if ``name``'s installed version is unsupported."""
    try:
        installed = importlib_metadata.version(name)
    except importlib_metadata.PackageNotFoundError:
        return f"{name} is not installed (requires {_format_bounds(lower, upper)})"

    parsed = _version_tuple(installed)
    if (lower is not None and parsed < lower) or (upper is not None and parsed >= upper):
        return f"{name} {installed} does not satisfy {_format_bounds(lower, upper)}"
    return None


def _installed_project_is_current() -> bool:
    try:
        installed_version = importlib_metadata.version(PROJECT_NAME)
    except importlib_metadata.PackageNotFoundError:
        return False
    return installed_version == _project_version()


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


def _venv_has_dependencies() -> bool:
    if not VENV_PYTHON.exists():
        return False

    code = "import run_dashboard, sys; sys.exit(0 if run_dashboard._current_python_has_dependencies() else 1)"
    return subprocess.run([str(VENV_PYTHON), "-c", code], cwd=ROOT, check=False).returncode == 0


def _venv_dependency_problems() -> list[str]:
    """Ask the venv interpreter which dependency checks fail (for diagnostics)."""
    if not VENV_PYTHON.exists():
        return [f"virtual environment interpreter is missing at {VENV_PYTHON}"]

    code = (
        "import run_dashboard, json, sys; "
        "sys.stdout.write(json.dumps(run_dashboard._dependency_problems()))"
    )
    result = subprocess.run(
        [str(VENV_PYTHON), "-c", code],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    try:
        problems = json.loads(result.stdout)
    except (ValueError, TypeError):
        stderr = result.stderr.strip()
        detail = f": {stderr}" if stderr else ""
        return [f"the virtual environment could not be inspected{detail}"]
    return [str(problem) for problem in problems]


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
            "Installing/updating investment-dashboard and dependencies (about a minute) ...",
            flush=True,
        )
        _ensure_venv_has_pip()
        _run_checked([str(VENV_PYTHON), "-m", "pip", "install", "--upgrade", "pip"], "pip upgrade")
        _run_checked(
            [str(VENV_PYTHON), "-m", "pip", "install", "--upgrade", "-e", "."],
            "Dependency install",
        )
        _run_checked(
            [str(VENV_PYTHON), "-m", "pip", "install", "pytest"],
            "Pytest install",
        )


def _relaunch_from_venv_if_needed() -> None:
    if _is_running_from_venv() and _current_python_has_dependencies():
        return

    _ensure_venv_ready()
    if not _venv_has_dependencies():
        problems = _venv_dependency_problems()
        detail = ("\n  - " + "\n  - ".join(problems)) if problems else ""
        raise RuntimeError(
            "The virtual environment is missing required dependencies after setup."
            + detail
            + "\nDelete the .venv folder and re-run this launcher to rebuild it."
        )
    if not _is_running_from_venv() or not _current_python_has_dependencies():
        os.execv(
            str(VENV_PYTHON), [str(VENV_PYTHON), str(ROOT / "run_dashboard.py"), *sys.argv[1:]]
        )


def main() -> int:
    try:
        _ensure_supported_python()
        _relaunch_from_venv_if_needed()
        _stop_existing_dashboard_instances()
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
