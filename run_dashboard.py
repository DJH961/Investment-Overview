"""Double-clickable launcher for the Investment Dashboard.

Run with no command-line arguments — this file is the entry point a user
would put on the desktop or in a Windows ``Startup`` folder.

It performs three things:

1. Ensures the package is importable (adds ``./src`` to ``sys.path`` so
   running from a fresh clone works without ``pip install -e .``).
2. Boots the app via :func:`investment_dashboard.main.run`, which itself
   applies migrations, refreshes prices/FX best-effort, and registers a
   background ``ui.timer`` for near-live ETF prices.
3. ``ui.run(show=True)`` opens the default browser automatically.

If anything fails before the server starts (missing deps, etc.), the
exception is printed and the window stays open until the user presses
Enter — important when the script is launched by double-click on
Windows, where there is no terminal to scroll back through.
"""

from __future__ import annotations

import contextlib
import sys
import traceback
from pathlib import Path


def _ensure_src_on_path() -> None:
    here = Path(__file__).resolve().parent
    src = here / "src"
    if src.exists() and str(src) not in sys.path:
        sys.path.insert(0, str(src))


def main() -> int:
    _ensure_src_on_path()
    try:
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
