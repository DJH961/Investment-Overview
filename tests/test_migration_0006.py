"""Migration 0006: ``transactions`` gains a ``net_usd`` column, backfilled
from existing data — USD-native rows take ``net_native`` verbatim, everything
else derives ``net_eur × trade-date EUR→USD rate`` (forward-filled).

Runs on a real on-disk SQLite so the batch ALTER and the correlated-subquery
backfill execute exactly as they will in production (single-file layout).
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


def test_0006_adds_and_backfills_net_usd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "ledger.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    from investment_dashboard.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]

    cfg = _make_alembic_config()
    # Bring up through 0005 (transactions + accounts + fx_history all exist).
    command.upgrade(cfg, "9e4b3f6c2a17")

    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as conn:
        # A USD account and an EUR account.
        conn.exec_driver_sql(
            "INSERT INTO accounts (broker, account_label, native_currency, account_type) "
            "VALUES ('fidelity', 'US', 'USD', 'brokerage')"
        )
        conn.exec_driver_sql(
            "INSERT INTO accounts (broker, account_label, native_currency, account_type) "
            "VALUES ('vanguard', 'EU', 'EUR', 'brokerage')"
        )
        # FX history: EUR→USD = 1.25 on 2024-01-01 (forward-fills to later).
        conn.exec_driver_sql(
            "INSERT INTO fx_history (date, base, quote, rate, source) "
            "VALUES ('2024-01-01', 'EUR', 'USD', 1.25, 'test')"
        )
        # USD-native deposit: net_usd should become net_native verbatim.
        conn.exec_driver_sql(
            "INSERT INTO transactions "
            "(account_id, date, kind, net_native, net_eur, source) "
            "VALUES (1, '2024-02-01', 'deposit', 1000, 800, 'manual')"
        )
        # EUR-native deposit: net_usd should become net_eur × 1.25 = 625.
        conn.exec_driver_sql(
            "INSERT INTO transactions "
            "(account_id, date, kind, net_native, net_eur, source) "
            "VALUES (2, '2024-02-01', 'deposit', 500, 500, 'manual')"
        )
        # A row predating any FX history with no net_eur ⇒ stays NULL.
        conn.exec_driver_sql(
            "INSERT INTO transactions "
            "(account_id, date, kind, net_native, net_eur, source) "
            "VALUES (2, '2020-01-01', 'deposit', 10, NULL, 'manual')"
        )

    command.upgrade(cfg, "a1c7f2d9e3b8")

    with engine.begin() as conn:
        cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(transactions)").fetchall()}
        assert "net_usd" in cols

        rows = conn.exec_driver_sql(
            "SELECT account_id, net_native, net_eur, net_usd FROM transactions ORDER BY id"
        ).fetchall()
        # USD-native: verbatim native.
        assert rows[0] == (1, 1000, 800, 1000)
        # EUR-native: net_eur × 1.25.
        assert rows[1] == (2, 500, 500, 625)
        # Unpriceable row stays NULL for the boot/Settings backfill.
        assert rows[2][3] is None

    # Downgrade drops the column.
    command.downgrade(cfg, "9e4b3f6c2a17")
    with engine.begin() as conn:
        cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(transactions)").fetchall()}
        assert "net_usd" not in cols

    engine.dispose()
    get_settings.cache_clear()  # type: ignore[attr-defined]


def test_0006_is_idempotent_when_column_already_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: the migration must not raise ``duplicate column name`` when
    ``transactions.net_usd`` already exists.

    This reproduces the real-world boot crash where the table was created via
    ``create_all`` (the current model already carries ``net_usd``) or patched by
    the boot ``_ensure_added_columns`` guard while the Alembic version stayed at
    0005. Running ``upgrade head`` then re-adds an existing column.
    """
    db_path = tmp_path / "ledger.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    from investment_dashboard.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]

    cfg = _make_alembic_config()
    command.upgrade(cfg, "9e4b3f6c2a17")

    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as conn:
        # Simulate a prior create_all/guard run that already added the column
        # while the Alembic version table remains pinned at 0005.
        conn.exec_driver_sql("ALTER TABLE transactions ADD COLUMN net_usd NUMERIC(18, 6)")
        conn.exec_driver_sql(
            "INSERT INTO accounts (broker, account_label, native_currency, account_type) "
            "VALUES ('fidelity', 'US', 'USD', 'brokerage')"
        )
        conn.exec_driver_sql(
            "INSERT INTO transactions "
            "(account_id, date, kind, net_native, net_eur, source) "
            "VALUES (1, '2024-02-01', 'deposit', 1000, 800, 'manual')"
        )

    # Must not raise ``duplicate column name: net_usd``.
    command.upgrade(cfg, "a1c7f2d9e3b8")

    with engine.begin() as conn:
        cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(transactions)").fetchall()}
        assert "net_usd" in cols
        # The backfill still runs for the pre-existing column.
        net_usd = conn.exec_driver_sql("SELECT net_usd FROM transactions WHERE id = 1").scalar_one()
        assert net_usd == 1000

    engine.dispose()
    get_settings.cache_clear()  # type: ignore[attr-defined]
