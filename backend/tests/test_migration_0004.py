"""End-to-end check for migration 0004: ledger-side category/active columns
move into config-tier ``instrument_overrides`` without dropping any rows.

Uses Alembic's programmatic API against a real on-disk SQLite file so
the batch ALTERs run exactly as they will in production.
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


def test_0004_migrates_category_and_active_to_overrides(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "ledger.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    # Settings is cached; clear so the env var is picked up.
    from investment_dashboard.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]

    cfg = _make_alembic_config()

    # Bring schema up to 0003 (pre-split), seed an instrument with a
    # custom category and active=False, then run 0004.
    command.upgrade(cfg, "7c2f1d4a93b5")

    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "INSERT INTO instruments "
            "(symbol, name, asset_class, category, native_currency, "
            "expense_ratio, target_weight_pct, active) "
            "VALUES ('VTI', 'Total US', 'etf', 'US Stocks', 'USD', 0.0003, 60, 0)"
        )
        conn.exec_driver_sql(
            "INSERT INTO instruments "
            "(symbol, name, asset_class, category, native_currency, "
            "expense_ratio, target_weight_pct, active) "
            "VALUES ('VOO', 'S&P 500', 'etf', NULL, 'USD', NULL, NULL, 1)"
        )

    command.upgrade(cfg, "8d3a2e5b14c6")

    with engine.connect() as conn:
        # instrument_overrides exists and has the customised row only
        # (VOO has no category and active=True, both defaults, so no
        # override row is materialised).
        rows = conn.execute(
            sa.text(
                "SELECT instrument_id, category, active FROM instrument_overrides "
                "ORDER BY instrument_id"
            )
        ).all()
        assert len(rows) == 1
        _, category, active = rows[0]
        assert category == "US Stocks"
        assert active in (0, False)

        # Ledger ``instruments`` no longer has category / active /
        # target_weight_pct columns; expense_ratio stays.
        cols = {row[1] for row in conn.execute(sa.text("PRAGMA table_info('instruments')")).all()}
        assert "category" not in cols
        assert "active" not in cols
        assert "target_weight_pct" not in cols
        assert "expense_ratio" in cols
        assert "symbol" in cols

        # Both ledger rows survived the batch rebuild.
        count = conn.execute(sa.text("SELECT COUNT(*) FROM instruments")).scalar()
        assert count == 2
    engine.dispose()
    # Clear the cached settings so other tests aren't affected.
    get_settings.cache_clear()  # type: ignore[attr-defined]
