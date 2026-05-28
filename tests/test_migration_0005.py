"""Migration 0005: instrument_overrides gains three display-override columns
and the ``instruments.asset_class`` CHECK constraint widens to allow
``'unknown'``.

Asserts on a real on-disk SQLite so the batch ALTERs run as they will
in production.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config


def _make_alembic_config() -> Config:
    repo_root = Path(__file__).resolve().parents[1]
    cfg = Config(str(repo_root / "alembic.ini"))
    cfg.set_main_option("script_location", str(repo_root / "migrations"))
    return cfg


def test_0005_adds_override_columns_and_unknown_asset_class(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "ledger.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    from investment_dashboard.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]

    cfg = _make_alembic_config()
    # Bring up through 0004 (overrides table created), then seed.
    command.upgrade(cfg, "8d3a2e5b14c6")

    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "INSERT INTO instruments "
            "(symbol, name, asset_class, native_currency, expense_ratio) "
            "VALUES ('VTI', 'Total US', 'etf', 'USD', 0.0003)"
        )
        conn.exec_driver_sql(
            "INSERT INTO instrument_overrides (instrument_id, category, active) "
            "VALUES (1, 'US Stocks', 1)"
        )

    # Run 0005.
    command.upgrade(cfg, "9e4b3f6c2a17")

    with engine.begin() as conn:
        cols = {
            r[1]
            for r in conn.exec_driver_sql(
                "PRAGMA table_info(instrument_overrides)"
            ).fetchall()
        }
        assert {"name_override", "asset_class_override", "expense_ratio_override"} <= cols

        # Seed data preserved.
        rows = conn.exec_driver_sql(
            "SELECT instrument_id, category, active, name_override "
            "FROM instrument_overrides"
        ).fetchall()
        assert rows == [(1, "US Stocks", 1, None)]

        # New 'unknown' enum is now accepted.
        conn.exec_driver_sql(
            "INSERT INTO instruments (symbol, asset_class, native_currency) "
            "VALUES ('UNK', 'unknown', 'USD')"
        )

    # Downgrade restores the narrower CHECK and drops the new columns.
    # First write an 'unknown' row to confirm the downgrade coerces it
    # to 'etf' rather than violating the CHECK on re-creation.
    command.downgrade(cfg, "8d3a2e5b14c6")
    with engine.begin() as conn:
        cols = {
            r[1]
            for r in conn.exec_driver_sql(
                "PRAGMA table_info(instrument_overrides)"
            ).fetchall()
        }
        assert "name_override" not in cols
        rows = conn.exec_driver_sql(
            "SELECT symbol, asset_class FROM instruments WHERE symbol = 'UNK'"
        ).fetchall()
        assert rows == [("UNK", "etf")]

    engine.dispose()
    get_settings.cache_clear()  # type: ignore[attr-defined]
