"""Boot-sequence tests — verify skip_network short-circuit + nav coverage."""

from __future__ import annotations

from pathlib import Path

import pytest

from investment_dashboard.boot import run_boot_sequence


def test_skip_network_does_not_raise() -> None:
    """Calling boot in offline mode must not raise even with no DB seeded."""
    run_boot_sequence(skip_network=True)


def test_boot_creates_db_parent_for_migrations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fresh double-click startup should create the app data folder."""
    from investment_dashboard.config import get_settings

    db_path = tmp_path / "nested" / "fresh.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    get_settings.cache_clear()
    try:
        run_boot_sequence(skip_network=True)
    finally:
        get_settings.cache_clear()

    assert db_path.exists()


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
