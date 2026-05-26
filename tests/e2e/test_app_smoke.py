"""End-to-end smoke test — verifies the app's boot + page-registration
sequence runs cleanly without network access.

This is intentionally cheap: it does **not** spin up an HTTP server. It
exercises the same code path that ``main.run()`` takes minus the
``ui.run()`` listener loop, so any import-time bug, ORM model issue, or
NiceGUI route-decorator error is caught by CI.
"""

from __future__ import annotations


def test_boot_and_register_pages_offline() -> None:
    """Apply migrations + register every page without touching the network."""
    from investment_dashboard.boot import run_boot_sequence
    from investment_dashboard.main import _register_pages

    run_boot_sequence(skip_network=True)
    _register_pages()


def test_version_is_v1() -> None:
    from investment_dashboard import __version__

    assert __version__.startswith("1."), f"expected 1.x, got {__version__}"
