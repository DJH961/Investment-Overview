"""First-run installer for Investment Dashboard on Windows.

PyInstaller freezes this module into ``InvestmentDashboard-Setup.exe``. The
frozen ``.exe`` is intentionally tiny and *version-agnostic*: at runtime it
fetches the **latest** Investment Dashboard release from GitHub. That way
the same installer binary keeps working for every v2.x release without
ever being rebuilt.

Flow on first launch:

1. Pick install root — ``%LOCALAPPDATA%\\InvestmentDashboard`` (no admin).
2. Download the official CPython 3.12 *embeddable* zip from python.org
   (~10 MB) and extract it into ``<root>\\python``.
3. Enable ``import site`` in ``python312._pth`` so ``pip`` can install
   packages into ``site-packages``.
4. Bootstrap ``pip`` via ``get-pip.py``.
5. Resolve the latest GitHub release and ``pip install`` it (wheel asset
   when present, source tarball otherwise).
6. Write the ``launcher.py`` file into the install root and create
   Start-menu + Desktop shortcuts pointing at it via ``pythonw.exe``.
7. Launch the dashboard immediately so the user does not have to
   double-click anything else.

The module is structured so each step is a small, side-effected function:
when running under PyInstaller this gives clearer error messages, and
during development we can call the helpers from a normal interpreter.
"""

from __future__ import annotations

import contextlib
import io
import os
import shutil
import subprocess
import sys
import traceback
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

from installer.paths import (
    APP_DISPLAY_NAME,
    APP_NAME,
    default_install_root,
    launcher_path,
    python_dir,
    python_executable,
    pythonw_executable,
)
from installer.version import (
    USER_AGENT,
    resolve_latest_release,
    tarball_url,
)

# Pin the embeddable Python version. Updating this constant is the *only*
# reason the installer ``.exe`` itself ever needs to be rebuilt.
EMBED_PYTHON_VERSION = "3.12.7"
EMBED_PYTHON_URL = (
    f"https://www.python.org/ftp/python/{EMBED_PYTHON_VERSION}/"
    f"python-{EMBED_PYTHON_VERSION}-embed-amd64.zip"
)
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"
NETWORK_TIMEOUT_SECONDS = 60


def _download(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=NETWORK_TIMEOUT_SECONDS) as response:
        return response.read()


def extract_embedded_python(install_root: Path) -> Path:
    """Download and unzip embeddable Python into ``<install_root>/python``."""
    target = python_dir(install_root)
    if python_executable(install_root).exists():
        return target

    print(f"Downloading Python {EMBED_PYTHON_VERSION} (embeddable) ...", flush=True)
    payload = _download(EMBED_PYTHON_URL)

    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        archive.extractall(target)
    return target


def enable_site_packages(python_root: Path) -> None:
    """Uncomment ``import site`` in the ``pythonXY._pth`` file.

    The embeddable distribution ships with ``import site`` commented out,
    which prevents ``pip`` from finding installed packages. We rewrite the
    ``._pth`` file so the interpreter behaves like a normal Python.
    """
    for pth in python_root.glob("python*._pth"):
        text = pth.read_text(encoding="utf-8")
        if "#import site" in text:
            text = text.replace("#import site", "import site")
        elif "import site" not in text:
            text = text.rstrip() + "\nimport site\n"
        pth.write_text(text, encoding="utf-8")


def install_pip(python_root: Path) -> None:
    """Bootstrap ``pip`` using the official ``get-pip.py`` script."""
    python_exe = python_root / "python.exe" if os.name == "nt" else python_root / "bin" / "python"
    if (
        subprocess.run(
            [str(python_exe), "-m", "pip", "--version"], check=False, capture_output=True
        ).returncode
        == 0
    ):
        return

    print("Installing pip ...", flush=True)
    get_pip = python_root / "get-pip.py"
    get_pip.write_bytes(_download(GET_PIP_URL))
    subprocess.check_call([str(python_exe), str(get_pip)])
    with contextlib.suppress(OSError):
        get_pip.unlink()


def install_latest_dashboard(install_root: Path) -> str:
    """``pip install`` the latest GitHub release. Returns the installed tag.

    Resolves the latest release via :func:`installer.version.resolve_latest_release`,
    which falls back from the GitHub JSON API to the public
    ``github.com/<repo>/releases/latest`` redirect when the API is
    unreachable (e.g. corporate proxies that block ``api.github.com`` and
    return HTTP 404). When the predicted wheel URL exists pip will use
    it; otherwise we fall back to the source tarball, which every release
    is guaranteed to have because GitHub auto-generates it.
    """
    print("Resolving latest Investment Dashboard release ...", flush=True)
    tag, wheel_url = resolve_latest_release(timeout=NETWORK_TIMEOUT_SECONDS)
    primary = wheel_url if wheel_url else tarball_url(tag)
    fallback = tarball_url(tag)

    python_exe = python_executable(install_root)
    print(f"Installing Investment Dashboard {tag} from {primary} ...", flush=True)
    try:
        subprocess.check_call(
            [str(python_exe), "-m", "pip", "install", "--upgrade", primary],
        )
    except subprocess.CalledProcessError:
        if primary == fallback:
            raise
        print(
            f"Wheel install failed; retrying with source tarball {fallback} ...",
            flush=True,
        )
        subprocess.check_call(
            [str(python_exe), "-m", "pip", "install", "--upgrade", fallback],
        )
    return tag


def write_launcher(install_root: Path) -> None:
    """Copy the steady-state launcher next to the embedded interpreter.

    When running under PyInstaller the launcher source is bundled as a
    data file at ``<sys._MEIPASS>/installer/launcher.py``. Outside the
    frozen build (e.g. tests), we resolve it relative to this module.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    base = Path(meipass) if meipass else Path(__file__).resolve().parent.parent
    source = base / "installer" / "launcher.py"
    shutil.copy2(source, launcher_path(install_root))


def create_shortcuts(install_root: Path) -> None:
    """Create Start-menu + Desktop shortcuts via PowerShell's WScript.Shell.

    No-op on non-Windows hosts so the function stays importable in tests.
    Shortcut creation failures are non-fatal — the user can still run the
    launcher manually from the install directory.
    """
    if os.name != "nt":
        return

    pythonw = pythonw_executable(install_root)
    launcher = launcher_path(install_root)
    appdata = os.environ.get("APPDATA")
    userprofile = os.environ.get("USERPROFILE")
    if not appdata or not userprofile:
        return

    start_menu = (
        Path(appdata)
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / f"{APP_DISPLAY_NAME}.lnk"
    )
    desktop = Path(userprofile) / "Desktop" / f"{APP_DISPLAY_NAME}.lnk"
    start_menu.parent.mkdir(parents=True, exist_ok=True)

    script = (
        "$ws = New-Object -ComObject WScript.Shell;"
        "foreach ($p in $env:INV_SHORTCUT_PATHS -split ';') {"
        "  $s = $ws.CreateShortcut($p);"
        "  $s.TargetPath = $env:INV_TARGET;"
        "  $s.Arguments = '\"' + $env:INV_LAUNCHER + '\"';"
        "  $s.WorkingDirectory = $env:INV_WORKDIR;"
        "  $s.IconLocation = $env:INV_TARGET + ',0';"
        "  $s.Save();"
        "}"
    )
    env = os.environ.copy()
    env["INV_TARGET"] = str(pythonw)
    env["INV_LAUNCHER"] = str(launcher)
    env["INV_WORKDIR"] = str(install_root)
    env["INV_SHORTCUT_PATHS"] = ";".join([str(start_menu), str(desktop)])
    with contextlib.suppress(subprocess.SubprocessError, OSError):
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            check=False,
            env=env,
            capture_output=True,
        )


def launch_dashboard(install_root: Path) -> None:
    """Start the dashboard in a detached process and return immediately."""
    args = [str(pythonw_executable(install_root)), str(launcher_path(install_root))]
    creationflags = 0
    if os.name == "nt":
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — keep the dashboard
        # alive after the installer console closes.
        creationflags = 0x00000008 | 0x00000200
    with contextlib.suppress(OSError):
        subprocess.Popen(args, cwd=str(install_root), close_fds=True, creationflags=creationflags)


def install(install_root: Path | None = None) -> int:
    root = install_root or default_install_root()
    root.mkdir(parents=True, exist_ok=True)
    print(f"Installing {APP_NAME} to {root} ...", flush=True)

    python_root = extract_embedded_python(root)
    enable_site_packages(python_root)
    install_pip(python_root)
    install_latest_dashboard(root)
    write_launcher(root)
    create_shortcuts(root)
    launch_dashboard(root)

    print("Installation complete. The dashboard is starting in a new window.", flush=True)
    return 0


def main() -> int:
    try:
        return install()
    except KeyboardInterrupt:
        print("\nInstallation cancelled.")
        return 1
    except Exception:
        traceback.print_exc()
        with contextlib.suppress(EOFError):
            input("\nInstallation failed. Press Enter to close…")
        return 1


if __name__ in {"__main__", "__mp_main__"}:
    sys.exit(main())
