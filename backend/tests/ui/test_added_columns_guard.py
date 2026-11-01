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


def test_intraday_value_reconcile_renames_legacy_total_column() -> None:
    """A legacy ``total_value_eur`` cache table (the v3.5.4 schema) is rebuilt
    on the current schema so the Overview "1 Day" query stops failing with
    ``no such column: intraday_value.market_value_eur``."""
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE intraday_value "
            "(captured_at DATETIME PRIMARY KEY, total_value_eur NUMERIC)"
        )

    boot._ensure_intraday_value_schema(engine)

    cols = _columns(engine, "intraday_value")
    assert "total_value_eur" not in cols
    assert "market_value_eur" in cols
    assert "fx_eur_usd" in cols
    engine.dispose()


def test_intraday_value_reconcile_adds_missing_fx_column() -> None:
    """A table renamed by Alembic ``head`` but lacking ``fx_eur_usd`` (the
    single-file migration recreates it without that column) gains it without
    dropping the table."""
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE intraday_value "
            "(captured_at DATETIME PRIMARY KEY, market_value_eur NUMERIC)"
        )
        conn.exec_driver_sql(
            "INSERT INTO intraday_value (captured_at, market_value_eur) "
            "VALUES ('2026-06-23 10:00:00', 100)"
        )

    boot._ensure_intraday_value_schema(engine)

    cols = _columns(engine, "intraday_value")
    assert "fx_eur_usd" in cols
    # The ALTER keeps existing rows (only a drop would lose them).
    with engine.begin() as conn:
        kept = conn.exec_driver_sql("SELECT COUNT(*) FROM intraday_value").scalar()
    assert kept == 1
    engine.dispose()


def test_intraday_value_reconcile_creates_missing_table() -> None:
    engine = sa.create_engine("sqlite:///:memory:")
    boot._ensure_intraday_value_schema(engine)
    cols = _columns(engine, "intraday_value")
    assert {"captured_at", "market_value_eur", "fx_eur_usd"} <= cols
    engine.dispose()


def test_intraday_value_reconcile_is_idempotent_on_current_schema() -> None:
    engine = sa.create_engine("sqlite:///:memory:")
    boot._ensure_intraday_value_schema(engine)
    before = _columns(engine, "intraday_value")
    # Second run must not raise or change the schema.
    boot._ensure_intraday_value_schema(engine)
    assert _columns(engine, "intraday_value") == before
    engine.dispose()
