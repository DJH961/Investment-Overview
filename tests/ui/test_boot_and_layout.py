"""Boot-sequence tests — verify skip_network short-circuit + nav coverage."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa

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


def test_boot_migrates_active_ledger_path_in_split_layout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fresh split-path startup must create ledger tables in the ledger DB."""
    from investment_dashboard.config import get_settings
    from investment_dashboard.db import dispose_engines

    ledger_path = tmp_path / "ledger.sqlite"
    monkeypatch.delenv("INV_DASHBOARD_DB_PATH", raising=False)
    monkeypatch.setenv("INV_DASHBOARD_LEDGER_PATH", str(ledger_path))
    monkeypatch.setenv("INV_DASHBOARD_CONFIG_PATH", str(tmp_path / "config.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CACHE_PATH", str(tmp_path / "cache.sqlite"))
    get_settings.cache_clear()
    dispose_engines()
    try:
        run_boot_sequence(skip_network=True)
    finally:
        dispose_engines()
        get_settings.cache_clear()

    engine = sa.create_engine(f"sqlite:///{ledger_path.as_posix()}", future=True)
    try:
        with engine.connect() as conn:
            tables = {
                row[0]
                for row in conn.execute(
                    sa.text("SELECT name FROM sqlite_master WHERE type='table'")
                )
            }
    finally:
        engine.dispose()

    assert "transactions" in tables


def test_nav_items_cover_all_pages() -> None:
    from investment_dashboard.ui.layout import NAV_ITEMS

    paths = {item.path for item in NAV_ITEMS}
    assert paths == {
        "/overview",
        "/deposits",
        "/transactions",
        "/monthly",
        "/yearly",
        "/analytics",
        "/calculator",
        "/settings",
    }
