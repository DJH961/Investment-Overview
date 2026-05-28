"""Single-file Windows installer + self-updating launcher for the Investment Dashboard.

This package contains:

* :mod:`installer.version` — pure helpers for semver comparison and parsing the
  GitHub Releases API payload. These are fully unit-tested.
* :mod:`installer.launcher` — steady-state launcher that runs from
  ``%LOCALAPPDATA%\\InvestmentDashboard`` after first install. It checks
  GitHub for a newer release, optionally updates in place, and then starts
  the dashboard.
* :mod:`installer.bootstrap` — first-run installer. It downloads an
  embeddable CPython, enables ``site``, installs ``pip``, installs the
  latest ``investment-dashboard`` release from GitHub, drops Start-menu /
  Desktop shortcuts, and launches the dashboard. PyInstaller freezes this
  module into ``InvestmentDashboard-Setup.exe``.

The bootstrapper is intentionally tiny and version-agnostic: it always
pulls the *latest* GitHub Release at runtime, so it never has to be
rebuilt when a new dashboard version ships.
"""
