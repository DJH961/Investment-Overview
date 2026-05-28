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

import sys
import traceback


def main() -> int:
    try:
        from investment_dashboard.main import run  # noqa: PLC0415
    except ImportError:
        traceback.print_exc()
        print(
            "\nInvestment Dashboard is not installed in this portable bundle.\n"
            "Try re-downloading InvestmentDashboard-Portable.zip from the\n"
            "GitHub Releases page and extracting it again.",
            file=sys.stderr,
        )
        return 1
    run()
    return 0


if __name__ in {"__main__", "__mp_main__"}:
    sys.exit(main())
