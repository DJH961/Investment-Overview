"""Tests for the per-tier engine/session helpers in ``db.py``."""

from __future__ import annotations

from pathlib import Path

import pytest

from investment_dashboard import config as config_mod
from investment_dashboard import db as db_mod


@pytest.fixture(autouse=True)
def _reset_engines() -> None:
    db_mod.dispose_engines()
    yield
    db_mod.dispose_engines()


def _reload_settings() -> None:
    config_mod.get_settings.cache_clear()  # type: ignore[attr-defined]


def test_unified_mode_shares_a_single_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When all three paths are equal, engines collapse to one cache entry."""
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(tmp_path / "db.sqlite"))
    monkeypatch.delenv("INV_DASHBOARD_LEDGER_PATH", raising=False)
    monkeypatch.delenv("INV_DASHBOARD_CONFIG_PATH", raising=False)
    monkeypatch.delenv("INV_DASHBOARD_CACHE_PATH", raising=False)
    _reload_settings()

    settings = config_mod.get_settings()
    assert settings.is_split_db is False

    eng_l = db_mod.get_ledger_engine()
    eng_c = db_mod.get_config_engine()
    eng_x = db_mod.get_cache_engine()
    assert eng_l is eng_c is eng_x
    _reload_settings()


def test_split_mode_creates_three_engines(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INV_DASHBOARD_LEDGER_PATH", str(tmp_path / "ledger.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CONFIG_PATH", str(tmp_path / "config.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CACHE_PATH", str(tmp_path / "cache.sqlite"))
    _reload_settings()

    settings = config_mod.get_settings()
    assert settings.is_split_db is True

    eng_l = db_mod.get_ledger_engine()
    eng_c = db_mod.get_config_engine()
    eng_x = db_mod.get_cache_engine()
    assert eng_l is not eng_c
    assert eng_l is not eng_x
    assert eng_c is not eng_x
    # Parent dirs are auto-created.
    assert eng_l.url.database is not None
    _reload_settings()


def _synchronous(engine: object) -> str:
    from sqlalchemy import text

    with engine.connect() as conn:  # type: ignore[attr-defined]
        return str(conn.execute(text("PRAGMA synchronous")).scalar())


def test_split_mode_synchronous_levels(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Durable tiers fsync (FULL=2); the rebuildable cache stays NORMAL (1)."""
    monkeypatch.setenv("INV_DASHBOARD_LEDGER_PATH", str(tmp_path / "ledger.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CONFIG_PATH", str(tmp_path / "config.sqlite"))
    monkeypatch.setenv("INV_DASHBOARD_CACHE_PATH", str(tmp_path / "cache.sqlite"))
    _reload_settings()

    assert _synchronous(db_mod.get_ledger_engine()) == "2"  # FULL
    assert _synchronous(db_mod.get_config_engine()) == "2"  # FULL
    assert _synchronous(db_mod.get_cache_engine()) == "1"  # NORMAL
    _reload_settings()


def test_unified_mode_cache_is_durable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """In single-file mode the shared engine is durable, so the cache is FULL too."""
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(tmp_path / "db.sqlite"))
    monkeypatch.delenv("INV_DASHBOARD_LEDGER_PATH", raising=False)
    monkeypatch.delenv("INV_DASHBOARD_CONFIG_PATH", raising=False)
    monkeypatch.delenv("INV_DASHBOARD_CACHE_PATH", raising=False)
    _reload_settings()

    assert _synchronous(db_mod.get_cache_engine()) == "2"  # FULL (shared with ledger)
    _reload_settings()
