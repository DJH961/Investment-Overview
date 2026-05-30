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

**Self-contained on purpose.** ``installer.bootstrap.write_launcher`` copies
*only this file* into the install root; the ``installer`` package is never
installed alongside the dashboard wheel. Importing ``installer.paths`` or
``installer.version`` at runtime therefore raised
``ModuleNotFoundError: No module named 'installer'`` and the installed
program never started. To stay robust the launcher now inlines the few
standard-library-only helpers it needs (path layout, version comparison and
release resolution) so it depends on nothing but the standard library and
the installed ``investment_dashboard`` wheel.
"""

from __future__ import annotations

import contextlib
import datetime
import importlib.metadata as importlib_metadata
import json
import os
import platform
import subprocess
import sys
import traceback
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Inlined constants and helpers (mirrors of ``installer.paths`` /
# ``installer.version``). Kept here verbatim so the copied launcher.py has
# zero dependency on the ``installer`` package being importable at runtime.
# ---------------------------------------------------------------------------

PROJECT_NAME = "investment-dashboard"
APP_NAME = "InvestmentDashboard"
VERSION_STATE_FILENAME = "installed_version.txt"

#: The Start-menu / Desktop shortcut points ``pythonw.exe`` at this launcher.
#: ``pythonw.exe`` has **no console**, so ``sys.stdout`` / ``sys.stderr`` are
#: ``None`` and every ``print`` / traceback (from the launcher itself, from
#: ``pip``, and from NiceGUI/uvicorn) is silently discarded — which is exactly
#: why a broken install "never runs" with no visible error. The launcher
#: therefore mirrors all of its output to this log file inside the install
#: root so a failed start always leaves a diagnosable trail. Setting
#: ``INV_DASHBOARD_LAUNCHER_DEBUG=1`` raises the dashboard log level to DEBUG.
LAUNCHER_LOG_FILENAME = "launcher.log"

#: Truncate the diagnostics log once it grows past this size so it never
#: balloons across many launches. One launch's output is tiny, so this only
#: trims accumulated history.
_LOG_MAX_BYTES = 1_000_000

_DEBUG_ENV = "INV_DASHBOARD_LAUNCHER_DEBUG"

#: Original interpreter streams captured at import time. Under ``pythonw.exe``
#: these are ``None``; under ``python.exe`` (a console diagnostic run) they are
#: real streams we still want to write to in addition to the log file.
_ORIGINAL_STDOUT = sys.stdout
_ORIGINAL_STDERR = sys.stderr

GITHUB_REPO = "DJH961/Investment-Overview"
LATEST_RELEASE_API = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
LATEST_RELEASE_HTML = f"https://github.com/{GITHUB_REPO}/releases/latest"
USER_AGENT = "InvestmentDashboard-Installer"

#: Maximum number of numeric components we compare from a version string.
_VERSION_COMPONENT_COUNT = 3

NETWORK_TIMEOUT_SECONDS = 10
_SKIP_UPDATE_ENV = "INV_DASHBOARD_SKIP_UPDATE_CHECK"


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


def python_executable(install_root: Path) -> Path:
    """Path to the embedded Python interpreter inside ``install_root``."""
    if os.name == "nt":
        return install_root / "python" / "python.exe"
    return install_root / "python" / "bin" / "python"


def version_state_path(install_root: Path) -> Path:
    return install_root / VERSION_STATE_FILENAME


def parse_version(version: str) -> tuple[int, ...]:
    """Return a comparable tuple from a ``X.Y.Z`` version string.

    Leading ``v`` / ``V`` is stripped (so GitHub tag names like ``v2.1.0`` and
    plain wheel versions like ``2.1.0`` parse identically). Non-numeric
    suffixes such as ``-rc1`` or ``.dev0`` are ignored.
    """
    cleaned = version.strip()
    if cleaned[:1] in {"v", "V"}:
        cleaned = cleaned[1:]

    parts: list[int] = []
    for token in cleaned.replace("-", ".").split("."):
        number = ""
        for char in token:
            if not char.isdigit():
                break
            number += char
        if number:
            parts.append(int(number))
        if len(parts) == _VERSION_COMPONENT_COUNT:
            break

    while len(parts) < _VERSION_COMPONENT_COUNT:
        parts.append(0)
    return tuple(parts[:_VERSION_COMPONENT_COUNT])


def is_newer(remote: str, current: str) -> bool:
    """Return ``True`` iff ``remote`` is strictly newer than ``current``."""
    return parse_version(remote) > parse_version(current)


def tarball_url(tag: str) -> str:
    """URL of the GitHub-generated source tarball for ``tag``."""
    return f"https://github.com/{GITHUB_REPO}/archive/refs/tags/{tag}.tar.gz"


def predicted_wheel_url(tag: str) -> str:
    """Best-guess URL of the wheel asset attached to release ``tag``."""
    version = tag[1:] if tag[:1] in {"v", "V"} else tag
    return (
        f"https://github.com/{GITHUB_REPO}/releases/download/{tag}/"
        f"investment_dashboard-{version}-py3-none-any.whl"
    )


def _extract_release_metadata(payload: Mapping[str, Any]) -> tuple[str, str | None]:
    """Pull the (tag, wheel URL) pair from a GitHub ``releases/latest`` payload."""
    tag = payload.get("tag_name")
    if not isinstance(tag, str) or not tag:
        raise ValueError("GitHub release payload is missing 'tag_name'.")

    wheel_url: str | None = None
    assets = payload.get("assets")
    if isinstance(assets, list):
        for asset in assets:
            if not isinstance(asset, Mapping):
                continue
            name = asset.get("name")
            url = asset.get("browser_download_url")
            if (
                isinstance(name, str)
                and isinstance(url, str)
                and name.startswith("investment_dashboard-")
                and name.endswith(".whl")
            ):
                wheel_url = url
                break

    return tag, wheel_url


def _tag_from_release_redirect(final_url: str) -> str:
    """Extract the tag from the URL ``releases/latest`` redirects to."""
    cleaned = final_url.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    if "/releases/tag/" not in cleaned:
        raise ValueError(f"Unexpected releases/latest redirect target: {final_url!r}")
    return cleaned.rsplit("/", 1)[-1]


def resolve_latest_release(
    timeout: float = 30.0,
    *,
    api_url: str = LATEST_RELEASE_API,
    html_url: str = LATEST_RELEASE_HTML,
) -> tuple[str, str | None]:
    """Resolve the latest release tag and (when known) wheel URL.

    Hits the GitHub JSON API first and falls back to the public
    ``releases/latest`` redirect when ``api.github.com`` is blocked.
    """
    try:
        request = Request(
            api_url,
            headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"},
        )
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return _extract_release_metadata(payload)
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
        pass

    request = Request(html_url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        tag = _tag_from_release_redirect(response.url)
    return tag, predicted_wheel_url(tag)


# ---------------------------------------------------------------------------
# Diagnostics — capture output even when launched via ``pythonw.exe``
# ---------------------------------------------------------------------------


class _Tee:
    """Minimal write-only stream that fans output out to several sinks.

    Used to mirror ``sys.stdout`` / ``sys.stderr`` to the diagnostics log file
    *and*, when present, to the real console stream. Every method is defensive:
    a sink that is ``None`` or raises (e.g. the absent ``pythonw`` console) is
    skipped so logging can never crash the launcher.
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


def diagnostics_log_path(install_root: Path) -> Path:
    """Location of the launcher diagnostics log inside ``install_root``."""
    return install_root / LAUNCHER_LOG_FILENAME


def _open_log_stream(install_root: Path) -> Any | None:
    """Open (and size-cap) the diagnostics log. Returns ``None`` on failure."""
    try:
        install_root.mkdir(parents=True, exist_ok=True)
        path = diagnostics_log_path(install_root)
        with contextlib.suppress(OSError):
            if path.exists() and path.stat().st_size > _LOG_MAX_BYTES:
                path.unlink()
        # Line-buffered so a hard crash still flushes the most recent lines.
        return open(path, "a", encoding="utf-8", buffering=1)
    except OSError:
        return None


def _log_environment(install_root: Path) -> None:
    """Write a header describing the runtime so failures are diagnosable."""
    stamp = datetime.datetime.now().isoformat(timespec="seconds")
    print("=" * 72, flush=True)
    print(f"Investment Dashboard launcher started {stamp}", flush=True)
    print(f"  install root      : {install_root}", flush=True)
    print(f"  python executable : {sys.executable}", flush=True)
    print(f"  python version    : {sys.version.splitlines()[0]}", flush=True)
    print(f"  platform          : {platform.platform()}", flush=True)
    print(f"  argv              : {sys.argv}", flush=True)
    print(f"  cwd               : {os.getcwd()}", flush=True)
    print(f"  installed version : {installed_version() or '(not installed)'}", flush=True)
    print("=" * 72, flush=True)


def install_diagnostics(install_root: Path) -> Any | None:
    """Redirect stdout/stderr to the diagnostics log and log the environment.

    ``pythonw.exe`` provides no console, so without this every message and
    traceback is lost and a broken install looks like it "does nothing".
    Mirroring to a file (and to the console when one exists) means any failure
    leaves a trail the user can report. Returns the opened log stream, or
    ``None`` if the log could not be created (in which case the launcher still
    runs — just without file diagnostics).
    """
    stream = _open_log_stream(install_root)
    if stream is None:
        return None
    sys.stdout = _Tee(stream, _ORIGINAL_STDOUT)
    sys.stderr = _Tee(stream, _ORIGINAL_STDERR)
    if os.environ.get(_DEBUG_ENV):
        os.environ.setdefault("INV_DASHBOARD_LOG_LEVEL", "DEBUG")
    with contextlib.suppress(Exception):
        _log_environment(install_root)
    return stream


# ---------------------------------------------------------------------------
# Launcher logic
# ---------------------------------------------------------------------------


def installed_version() -> str | None:
    """Return the installed dashboard version, or ``None`` if not installed."""
    try:
        return importlib_metadata.version(PROJECT_NAME)
    except importlib_metadata.PackageNotFoundError:
        return None


def fetch_latest_release(
    timeout: float = NETWORK_TIMEOUT_SECONDS,
) -> tuple[str, str | None] | None:
    """Resolve the latest release as ``(tag, wheel_url)``.

    Returns ``None`` on any network failure so the launcher can skip the
    update check and start the app.
    """
    try:
        return resolve_latest_release(timeout=timeout)
    except (URLError, HTTPError, TimeoutError, OSError, ValueError):
        return None


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
    resolved = fetch_latest_release()
    if resolved is None:
        return None
    tag, wheel_url = resolved

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
    """Import and run the dashboard. Returns the process exit code.

    Any failure here — a missing dependency in the embedded interpreter, a
    port already in use, a NiceGUI/uvicorn startup error — is logged with a
    full traceback rather than silently killing the (console-less) process.
    """
    try:
        from investment_dashboard.main import run  # noqa: PLC0415
    except Exception:
        print("Failed to import the dashboard application:", flush=True)
        traceback.print_exc()
        return 1
    try:
        run()
    except Exception:
        print("The dashboard crashed while starting:", flush=True)
        traceback.print_exc()
        return 1
    return 0


def main() -> int:
    install_root = default_install_root()
    log_stream = install_diagnostics(install_root)
    try:
        try:
            maybe_update(install_root)
        except Exception:
            print("Update check failed (continuing with installed version):", flush=True)
            traceback.print_exc()
        return start_dashboard()
    except Exception:
        # Last-resort guard so nothing escapes unlogged under pythonw.exe.
        print("Unexpected launcher failure:", flush=True)
        traceback.print_exc()
        return 1
    finally:
        if log_stream is not None:
            with contextlib.suppress(Exception):
                log_stream.flush()


if __name__ in {"__main__", "__mp_main__"}:
    sys.exit(main())
