"""Migration 0024: twin prices -> symbol prices (kind) + holding_daily_values (up + down)."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

_BEFORE = "f6b2d8a4c913"  # 0023
_AFTER = "a7c3e9d1b524"  # 0024


def _cfg() -> Config:
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "migrations"))
    return cfg


def test_0024_up_and_down(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "ledger.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    from investment_dashboard.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    cfg = _cfg()
    command.upgrade(cfg, _BEFORE)
    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO intraday_twin_prices (symbol, captured_at, price_native) "
                "VALUES ('VOO', '2026-11-04 21:00:00', 500.5)"
            )
        )

    command.upgrade(cfg, _AFTER)
    insp = sa.inspect(engine)
    names = set(insp.get_table_names())
    assert "intraday_twin_prices" not in names
    assert {"intraday_symbol_prices", "holding_daily_values"} <= names
    assert insp.get_pk_constraint("intraday_symbol_prices")["constrained_columns"] == [
        "symbol",
        "kind",
        "captured_at",
    ]
    with engine.begin() as conn:
        rows = conn.execute(sa.text("SELECT symbol, kind FROM intraday_symbol_prices")).all()
        assert [tuple(r) for r in rows] == [("VOO", "twin")]
        conn.execute(
            sa.text(
                "INSERT INTO intraday_symbol_prices (symbol, kind, captured_at, price_native) "
                "VALUES ('VOO', 'holding', '2026-11-04 21:00:00', 500.6)"
            )
        )

    command.downgrade(cfg, _BEFORE)
    insp = sa.inspect(engine)
    names = set(insp.get_table_names())
    assert "intraday_symbol_prices" not in names
    assert "holding_daily_values" not in names
    with engine.connect() as conn:
        rows = conn.execute(sa.text("SELECT symbol, price_native FROM intraday_twin_prices")).all()
        assert len(rows) == 1  # only the twin row goes back

    command.upgrade(cfg, _AFTER)  # and back up again cleanly
    engine.dispose()
    get_settings.cache_clear()  # type: ignore[attr-defined]
