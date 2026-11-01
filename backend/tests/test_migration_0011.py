"""Migration 0011: persist the no-buy distinction and calculator settings.

A pre-v3.5.3 ledger has ``target_allocations`` / ``target_allocation_items``
without the ``allow_sell`` / ``display_currency`` / ``no_buy`` columns. The
migration must add all three idempotently, defaulting existing rows to the
buy-only / no-currency / buyable state.

Runs on a real on-disk SQLite so the ``ADD COLUMN`` executes exactly as in
production.
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


def test_0011_adds_allocation_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "ledger.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    from investment_dashboard.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]

    cfg = _make_alembic_config()
    # Bring the schema up through 0010 (pre-settings target allocations).
    command.upgrade(cfg, "f6c2d0a4b8e3")

    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(target_allocations)")}
        assert "allow_sell" not in cols
        assert "display_currency" not in cols
        item_cols = {
            row[1] for row in conn.exec_driver_sql("PRAGMA table_info(target_allocation_items)")
        }
        assert "no_buy" not in item_cols
        # Seed a legacy target with one item under the old schema.
        conn.exec_driver_sql(
            "INSERT INTO target_allocations (id, name, active) VALUES (1, 'Legacy', 1)"
        )
        conn.exec_driver_sql(
            "INSERT INTO target_allocation_items "
            "(target_allocation_id, instrument_id, weight_pct) VALUES (1, 42, '100.00')"
        )

    # Apply the new migration.
    command.upgrade(cfg, "a7d3e1f9c4b6")

    with engine.begin() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(target_allocations)")}
        assert {"allow_sell", "display_currency"} <= cols
        item_cols = {
            row[1] for row in conn.exec_driver_sql("PRAGMA table_info(target_allocation_items)")
        }
        assert "no_buy" in item_cols
        # Existing rows default to buy-only / no currency / buyable.
        row = conn.exec_driver_sql(
            "SELECT allow_sell, display_currency FROM target_allocations WHERE id = 1"
        ).one()
        assert row[0] == 0
        assert row[1] is None
        no_buy = conn.exec_driver_sql(
            "SELECT no_buy FROM target_allocation_items WHERE target_allocation_id = 1"
        ).scalar_one()
        assert no_buy == 0

    engine.dispose()
