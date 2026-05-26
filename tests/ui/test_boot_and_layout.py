"""Boot-sequence tests — verify skip_network short-circuit + nav coverage."""

from __future__ import annotations

from investment_dashboard.boot import run_boot_sequence


def test_skip_network_does_not_raise() -> None:
    """Calling boot in offline mode must not raise even with no DB seeded."""
    run_boot_sequence(skip_network=True)


def test_nav_items_cover_all_seven_pages() -> None:
    from investment_dashboard.ui.layout import NAV_ITEMS

    paths = {item.path for item in NAV_ITEMS}
    assert paths == {
        "/overview",
        "/deposits",
        "/transactions",
        "/monthly",
        "/yearly",
        "/calculator",
        "/settings",
    }
