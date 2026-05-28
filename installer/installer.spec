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


a = Analysis(
    [str(HERE / "bootstrap.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=[],
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
    # UPX must stay disabled: compressing the bundled Windows UCRT/VC runtime
    # DLLs (notably ``ucrtbase.dll``) causes the PyInstaller bootloader to
    # extract a corrupt image, producing the "Bad Image" dialog with status
    # ``0xc0e90002`` on end-user machines. See the issue reported against
    # ``InvestmentDashboard-Setup.exe``.
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
