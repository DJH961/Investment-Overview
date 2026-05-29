# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for ``InvestmentDashboard-Setup.exe``.

Builds a one-file Windows executable from ``installer/bootstrap.py`` that
bundles the small ``installer`` helper package (``paths``, ``version``,
``launcher``). The resulting binary is intentionally version-agnostic —
it downloads the embeddable CPython runtime and the latest dashboard
release at install time — so it only needs to be rebuilt when the
bootstrap logic itself changes.

Invoked by ``.github/workflows/release.yml`` via::

    pyinstaller --clean --noconfirm installer/installer.spec
"""

from pathlib import Path

# ``__file__`` is not defined inside a PyInstaller spec; ``SPECPATH`` is
# the directory containing this spec file and is provided by PyInstaller.
HERE = Path(SPECPATH).resolve()
PROJECT_ROOT = HERE.parent

# Bundle every wheel found in ``dist/`` into the installer under a
# ``bundled_wheels/`` directory. The release workflow downloads the
# ``dist`` build artifact (which contains the freshly built
# ``investment_dashboard-*.whl``) into this folder before invoking
# PyInstaller, so the resulting ``.exe`` carries the wheel for the tag
# being released. At install time ``bootstrap.install_latest_dashboard``
# pip-installs that bundled wheel directly, which means the installer
# does **not** need to talk to ``api.github.com`` / ``github.com`` to
# resolve the latest release. That matters because the repository is
# private: anonymous GitHub requests for its release metadata return
# HTTP 404, and the end-user's machine has no GitHub credentials.
_DIST_DIR = PROJECT_ROOT / "dist"
_bundled_wheels = [
    (str(wheel), "bundled_wheels") for wheel in sorted(_DIST_DIR.glob("investment_dashboard-*.whl"))
]

# ``installer/launcher.py`` is also imported as a Python module (see
# ``hiddenimports`` below) so it ends up in the PYZ, but
# ``bootstrap.write_launcher`` needs the **source file on disk** under
# ``sys._MEIPASS`` so it can ``shutil.copy2`` it into the user's install
# root as the steady-state entry-point. Bundle it as a data file under
# ``installer/launcher.py`` to match the path that ``write_launcher``
# resolves at runtime.
_launcher_source = HERE / "launcher.py"
_bundled_launcher = [(str(_launcher_source), "installer")]


a = Analysis(
    [str(HERE / "bootstrap.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=_bundled_wheels + _bundled_launcher,
    hiddenimports=[
        "installer",
        "installer.paths",
        "installer.version",
        "installer.launcher",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="InvestmentDashboard-Setup",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX is left disabled for defence in depth: if a future change ever
    # adds UPX to the build runner, compressing the bundled UCRT/VC runtime
    # DLLs is known to corrupt them as well. The *primary* fix for the
    # "Bad Image" dialog with status ``0xc0e90002`` reported against
    # ``InvestmentDashboard-Setup.exe`` is pinning the build job to
    # ``windows-2022`` (see ``.github/workflows/release.yml``) so the
    # bundled ``ucrtbase.dll`` / api-set forwarders are compatible with
    # Windows 10 / 11 client machines. ``windows-latest`` now resolves to
    # Windows Server 2025, whose UCRT is incompatible with those clients.
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
