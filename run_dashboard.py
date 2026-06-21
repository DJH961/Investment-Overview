"""Double-clickable launcher for the Investment Dashboard.

Run with no command-line arguments. This file is the entry point a user
would put on the desktop or in a Windows Startup folder.

On first run it creates ``.venv`` and installs the project dependencies,
then re-launches itself with the virtualenv Python before importing the
application.

The launcher is designed to run **without a console window** (e.g. double-clicked
via ``run_dashboard.vbs`` / a ``pythonw.exe`` shortcut). Under ``pythonw.exe``
``sys.stdout`` / ``sys.stderr`` are ``None``, so every ``print`` and traceback
would otherwise vanish. To keep failures diagnosable the launcher tees all of
its output to a rotating ``launcher.log`` beside this file, and if anything
fails before the server starts it shows a **native error dialog** (pointing at
the log) so a silent double-click never just "does nothing". When a real console
*is* attached (``run_dashboard.bat`` / running from a shell, which sets
``INV_DASHBOARD_CONSOLE``), the familiar "Press Enter to close" prompt is kept
instead so power users can read the output live.
"""

from __future__ import annotations

import contextlib
import importlib.metadata as importlib_metadata
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tomllib
import traceback
from pathlib import Path
from typing import Any

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
#: Windows-only windowless interpreter. Relaunching into this (instead of
#: ``python.exe``) keeps the no-console experience: a console-subsystem
#: ``python.exe`` spawned from a windowless parent would pop a fresh console.
VENV_PYTHONW = VENV_DIR / "Scripts" / "pythonw.exe"

#: Diagnostics log beside this launcher. Mirrors the installer's launcher.log so
#: a failed no-console start always leaves a trail (see ``install_diagnostics``).
LAUNCHER_LOG = ROOT / "launcher.log"
#: Truncate the diagnostics log once it grows past this size so it never balloons
#: across many launches.
_LOG_MAX_BYTES = 1_000_000
#: Set by the console/diagnostic launchers (``run_dashboard.bat`` / a shell) so
#: the interactive "Press Enter" prompt is kept instead of the native dialog.
_CONSOLE_ENV = "INV_DASHBOARD_CONSOLE"

#: Original interpreter streams captured at import time. Under ``pythonw.exe``
#: these are ``None``; under ``python.exe`` they are real streams we still want
#: to write to *in addition* to the log file.
_ORIGINAL_STDOUT = sys.stdout
_ORIGINAL_STDERR = sys.stderr

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


# ---------------------------------------------------------------------------
# Diagnostics + visible error reporting (work even with no console)
# ---------------------------------------------------------------------------


class _Tee:
    """Write-only stream that fans output out to several sinks.

    Mirrors ``sys.stdout`` / ``sys.stderr`` to the diagnostics log file *and*,
    when present, to the real console stream. Every method is defensive: a sink
    that is ``None`` or raises (e.g. the absent ``pythonw`` console) is skipped
    so logging can never crash the launcher.
    """

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


def _console_attached() -> bool:
    """Whether a usable text console is attached to this process.

    Under ``pythonw.exe`` (the no-console launch path) the *original*
    ``sys.stdout`` / ``sys.stderr`` are ``None``; the console/diagnostic
    launchers set ``INV_DASHBOARD_CONSOLE`` so the interactive prompt is kept
    even if a redirected stream looks unusual.
    """
    if os.environ.get(_CONSOLE_ENV):
        return True
    return _ORIGINAL_STDOUT is not None and _ORIGINAL_STDERR is not None


def _open_log_stream() -> Any | None:
    """Open (and size-cap) the diagnostics log. Returns ``None`` on failure."""
    try:
        with contextlib.suppress(OSError):
            if LAUNCHER_LOG.exists() and LAUNCHER_LOG.stat().st_size > _LOG_MAX_BYTES:
                LAUNCHER_LOG.unlink()
        # Line-buffered so a hard crash still flushes the most recent lines.
        return open(LAUNCHER_LOG, "a", encoding="utf-8", buffering=1)
    except OSError:
        return None


def install_diagnostics() -> Any | None:
    """Tee stdout/stderr to the diagnostics log so no-console runs are debuggable.

    Returns the opened log stream, or ``None`` if the log could not be created
    (in which case the launcher still runs — just without file diagnostics).
    """
    stream = _open_log_stream()
    if stream is None:
        return None
    sys.stdout = _Tee(stream, _ORIGINAL_STDOUT)
    sys.stderr = _Tee(stream, _ORIGINAL_STDERR)
    return stream


def _message_box_windows(text: str) -> None:  # pragma: no cover - Windows only
    import ctypes  # noqa: PLC0415

    mb_iconerror = 0x10
    mb_systemmodal = 0x1000
    ctypes.windll.user32.MessageBoxW(  # type: ignore[attr-defined]
        None, text, "Investment Dashboard", mb_iconerror | mb_systemmodal
    )


def _message_box_macos(text: str) -> None:  # pragma: no cover - macOS only
    safe = text.replace("\\", "\\\\").replace('"', '\\"')
    script = (
        f'display dialog "{safe}" with title "Investment Dashboard" '
        'buttons {"OK"} default button "OK" with icon stop'
    )
    subprocess.run(["osascript", "-e", script], check=False, capture_output=True)


def _message_box_linux(text: str) -> None:  # pragma: no cover - Linux GUI only
    if shutil.which("zenity"):
        subprocess.run(
            ["zenity", "--error", "--title=Investment Dashboard", f"--text={text}"],
            check=False,
            capture_output=True,
        )
    elif shutil.which("kdialog"):
        subprocess.run(
            ["kdialog", "--title", "Investment Dashboard", "--error", text],
            check=False,
            capture_output=True,
        )
    elif shutil.which("notify-send"):
        subprocess.run(
            ["notify-send", "Investment Dashboard", text], check=False, capture_output=True
        )


def _show_error_dialog(summary: str, log_path: Path) -> None:
    """Best-effort native modal error dialog. Never raises.

    Shown only when there is no console to read the traceback from, so a
    windowless double-click that fails still surfaces *something* visible and
    points the user at the log file with the full details.
    """
    detail = (
        "Investment Dashboard could not start.\n\n"
        f"{summary}\n\n"
        f"Details were written to:\n{log_path}"
    )
    try:
        if os.name == "nt":
            _message_box_windows(detail)
        elif sys.platform == "darwin":
            _message_box_macos(detail)
        else:
            _message_box_linux(detail)
    except Exception:
        # The error reporter must never raise — the log already has the trace.
        pass


def _report_startup_failure(error: BaseException) -> None:
    """Surface a startup failure: native dialog with no console, prompt with one.

    The full traceback is already in ``launcher.log`` (and on the console when
    attached) via :func:`install_diagnostics`; this adds the *visible* signal.
    """
    summary = f"{type(error).__name__}: {error}".strip()
    if _console_attached():
        with contextlib.suppress(EOFError):
            input("\nPress Enter to close…")
    else:
        _show_error_dialog(summary, LAUNCHER_LOG)


def _venv_launch_python() -> Path:
    """Interpreter to relaunch into.

    Picks the windowless ``pythonw.exe`` when this process has no console (the
    no-console launch path) so the relaunched child stays console-less; otherwise
    the standard ``python.exe`` so console output keeps flowing.
    """
    if os.name == "nt" and not _console_attached() and VENV_PYTHONW.exists():
        return VENV_PYTHONW
    return VENV_PYTHON



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
        executable = Path(sys.executable).resolve()
    except OSError:
        return False
    candidates = {VENV_PYTHON.resolve()}
    if VENV_PYTHONW.exists():
        with contextlib.suppress(OSError):
            candidates.add(VENV_PYTHONW.resolve())
    return executable in candidates


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
    # Split on the first operator/extras/marker/whitespace char to isolate the
    # distribution name; the specific operator doesn't matter here.
    name = re.split(r"[<>=!~;\s\[]", entry, maxsplit=1)[0].strip().lower().replace("_", "-")
    if not name:
        return None

    lower: _Bound = None
    upper: _Bound = None
    # Only the operators this coarse floor/ceiling model understands are matched;
    # unsupported ones (bare ``>``/``<=``/``!=``) are intentionally not captured.
    for operator, raw_version in re.findall(r"(>=|==|~=|<)\s*([0-9]+(?:\.[0-9]+)*)", entry):
        version = _version_tuple(raw_version)
        if operator == "<":
            upper = version if upper is None else min(upper, version)
        else:
            lower = version if lower is None else max(lower, version)
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
        launch_python = _venv_launch_python()
        os.execv(
            str(launch_python), [str(launch_python), str(ROOT / "run_dashboard.py"), *sys.argv[1:]]
        )


def main() -> int:
    log_stream = install_diagnostics()
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
    except Exception as exc:
        traceback.print_exc()
        _report_startup_failure(exc)
        return 1
    finally:
        if log_stream is not None:
            with contextlib.suppress(Exception):
                log_stream.flush()
    return 0


if __name__ in {"__main__", "__mp_main__"}:
    sys.exit(main())
