"""The packaged-install ``create_all`` path can't ALTER existing tables, so
boot carries an idempotent "add missing columns" guard. This verifies it adds
``transactions.net_usd`` to a pre-existing table that lacks it, and is a no-op
on a second run.
"""

from __future__ import annotations

import sqlalchemy as sa

from investment_dashboard import boot


def _columns(engine: sa.Engine, table: str) -> set[str]:
    with engine.begin() as conn:
        return {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()}


def test_ensure_added_columns_adds_net_usd() -> None:
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        # Old-schema transactions table without net_usd.
        conn.exec_driver_sql(
            "CREATE TABLE transactions (id INTEGER PRIMARY KEY, net_native NUMERIC)"
        )
    assert "net_usd" not in _columns(engine, "transactions")

    boot._ensure_added_columns(engine)
    assert "net_usd" in _columns(engine, "transactions")

    # Idempotent: running again doesn't raise or duplicate.
    boot._ensure_added_columns(engine)
    assert "net_usd" in _columns(engine, "transactions")
    engine.dispose()


def test_ensure_added_columns_skips_missing_table() -> None:
    engine = sa.create_engine("sqlite:///:memory:")
    # No transactions table at all — guard must simply do nothing.
    boot._ensure_added_columns(engine)
    with engine.begin() as conn:
        names = {
            r[0]
            for r in conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    assert "transactions" not in names
    engine.dispose()
