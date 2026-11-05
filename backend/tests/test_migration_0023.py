"""Migration 0023: instrument twin column + twin price cache (upgrade + downgrade)."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

_BEFORE = "f1c6b8a2d4e7"  # 0022
_AFTER = "f6b2d8a4c913"  # 0023


def _cfg() -> Config:
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "migrations"))
    return cfg


def test_0023_up_and_down(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "ledger.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    from investment_dashboard.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    cfg = _cfg()
    command.upgrade(cfg, _BEFORE)
    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    insp = sa.inspect(engine)
    assert "intraday_twin_prices" not in insp.get_table_names()
    assert "intraday_twin" not in {c["name"] for c in insp.get_columns("instrument_overrides")}

    command.upgrade(cfg, _AFTER)
    insp = sa.inspect(engine)
    assert "intraday_twin" in {c["name"] for c in insp.get_columns("instrument_overrides")}
    assert {c["name"] for c in insp.get_columns("intraday_twin_prices")} == {
        "symbol",
        "captured_at",
        "price_native",
    }
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO instrument_overrides (instrument_id, active, intraday_twin) "
                "VALUES (1, 1, 'VOO')"
            )
        )
        conn.execute(
            sa.text(
                "INSERT INTO intraday_twin_prices (symbol, captured_at, price_native) "
                "VALUES ('VOO', '2026-11-04 21:00:00', 500.5)"
            )
        )

    command.downgrade(cfg, _BEFORE)
    insp = sa.inspect(engine)
    assert "intraday_twin_prices" not in insp.get_table_names()
    assert "intraday_twin" not in {c["name"] for c in insp.get_columns("instrument_overrides")}
    with engine.connect() as conn:
        # The rest of the override row survives the downgrade.
        assert conn.execute(sa.text("SELECT count(*) FROM instrument_overrides")).scalar() == 1

    command.upgrade(cfg, _AFTER)  # and back up again cleanly
    engine.dispose()
    get_settings.cache_clear()  # type: ignore[attr-defined]
