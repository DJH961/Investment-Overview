"""Migration 0009: rebrand the legacy EUR savings account to a brand-free code.

An older on-disk ledger tags its EUR savings account with a legacy broker code
and the synthetic Tagesgeld line with a legacy cash symbol. The migration must
relabel both — targeting them structurally — so the database keeps working
against the brand-free seed, while updating the ``ck_account_broker`` CHECK
constraint so the new broker code is accepted and unknown ones are still
rejected.

Runs on a real on-disk SQLite so the constraint rebuild executes exactly as in
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


def test_0009_rebrands_legacy_savings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "ledger.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    from investment_dashboard.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]

    cfg = _make_alembic_config()
    # Bring the schema up through 0008 (pre-rebrand).
    command.upgrade(cfg, "d4a9b2e7c5f1")

    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as conn:
        # Simulate a pre-v3.0 database whose savings account/instrument still
        # carry the old broker code and cash symbol. The schema's broker check
        # rejects a non-canonical code, so check enforcement is disabled just
        # for this seeding step — mirroring a real DB created on an old schema.
        conn.exec_driver_sql("PRAGMA ignore_check_constraints = ON")
        conn.exec_driver_sql(
            "INSERT INTO accounts (broker, account_label, native_currency, account_type, active) "
            "VALUES ('legacy_savings_code', 'Old Savings', 'EUR', 'savings', 1)"
        )
        conn.exec_driver_sql(
            "INSERT INTO accounts (broker, account_label, native_currency, account_type, active) "
            "VALUES ('vanguard', 'Vanguard Brokerage', 'USD', 'brokerage', 1)"
        )
        conn.exec_driver_sql(
            "INSERT INTO instruments (symbol, asset_class, native_currency) "
            "VALUES ('LEGACY_CASH', 'savings', 'EUR')"
        )
        conn.exec_driver_sql(
            "INSERT INTO instruments (symbol, asset_class, native_currency) "
            "VALUES ('VTI', 'etf', 'USD')"
        )
        conn.exec_driver_sql("PRAGMA ignore_check_constraints = OFF")

    # Apply 0009.
    command.upgrade(cfg, "e5b1c9a3f7d2")

    with engine.begin() as conn:
        brokers = {
            r[0] for r in conn.exec_driver_sql("SELECT broker FROM accounts").fetchall()
        }
        symbols = {
            r[0] for r in conn.exec_driver_sql("SELECT symbol FROM instruments").fetchall()
        }

    # Legacy savings code relabelled; brokerages untouched.
    assert brokers == {"savings_bank", "vanguard"}
    # Synthetic cash symbol relabelled; real instruments untouched.
    assert "SAVINGS_CASH" in symbols
    assert "VTI" in symbols
    assert "LEGACY_CASH" not in symbols

    # The rebuilt CHECK constraint accepts the new code...
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "INSERT INTO accounts (broker, account_label, native_currency, account_type, active) "
            "VALUES ('savings_bank', 'Another Savings', 'EUR', 'savings', 1)"
        )
    # ...and still rejects unknown broker codes.
    with pytest.raises(Exception):
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO accounts (broker, account_label, native_currency, account_type, active) "
                "VALUES ('not_a_broker', 'X', 'EUR', 'savings', 1)"
            )

    engine.dispose()
    get_settings.cache_clear()  # type: ignore[attr-defined]
