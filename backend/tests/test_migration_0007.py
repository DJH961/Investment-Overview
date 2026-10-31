"""Migration 0007: reclassify mis-booked Fidelity share distributions.

A Fidelity ``dividend_cash`` row that carries a non-zero share quantity but no
price is really a share distribution / split (the Schwab SCHK 2-for-1 split is
the canonical case). The migration promotes such rows to ``split`` and nulls the
money legs, while genuine cash dividends (zero quantity) are left untouched.

Runs on a real on-disk SQLite so the UPDATE executes exactly as in production.
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


def test_0007_reclassifies_share_distribution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "ledger.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    from investment_dashboard.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]

    cfg = _make_alembic_config()
    # Bring up through 0006 (net_usd present).
    command.upgrade(cfg, "a1c7f2d9e3b8")

    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "INSERT INTO accounts (broker, account_label, native_currency, account_type) "
            "VALUES ('fidelity', 'US', 'USD', 'brokerage')"
        )
        # Mis-booked share distribution: dividend_cash + quantity, no price.
        conn.exec_driver_sql(
            "INSERT INTO transactions "
            "(account_id, date, kind, quantity, price_native, gross_native, "
            " net_native, net_eur, net_usd, source) "
            "VALUES (1, '2024-10-11', 'dividend_cash', 26.1, NULL, NULL, "
            "728.97, 700, 728.97, 'import_fidelity_csv')"
        )
        # Genuine cash dividend: zero quantity — must stay a dividend.
        conn.exec_driver_sql(
            "INSERT INTO transactions "
            "(account_id, date, kind, quantity, price_native, net_native, source) "
            "VALUES (1, '2024-09-30', 'dividend_cash', 0, NULL, 4.36, 'import_fidelity_csv')"
        )
        # Reinvested cash leg: zero quantity — must stay a dividend.
        conn.exec_driver_sql(
            "INSERT INTO transactions "
            "(account_id, date, kind, quantity, price_native, net_native, source) "
            "VALUES (1, '2024-07-01', 'dividend_cash', 0, NULL, 4.30, 'import_fidelity_csv')"
        )

    command.upgrade(cfg, "c3f5a8d1b6e2")

    with engine.begin() as conn:
        rows = conn.exec_driver_sql(
            "SELECT date, kind, quantity, price_native, gross_native, "
            "net_native, net_eur, net_usd FROM transactions ORDER BY date"
        ).fetchall()
        by_date = {r[0]: r for r in rows}
        # The share distribution is now a split with nulled money legs.
        split = by_date["2024-10-11"]
        assert split[1] == "split"
        assert split[2] == 26.1
        assert split[3] is None  # price
        assert split[4] is None  # gross
        assert split[5] is None  # net_native
        assert split[6] is None  # net_eur
        assert split[7] is None  # net_usd
        # Genuine cash dividends are untouched.
        assert by_date["2024-09-30"][1] == "dividend_cash"
        assert by_date["2024-07-01"][1] == "dividend_cash"

    engine.dispose()
    get_settings.cache_clear()  # type: ignore[attr-defined]
