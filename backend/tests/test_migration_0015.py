"""Migration 0015: fx_conversions table (upgrade + downgrade)."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config


def _cfg() -> Config:
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "migrations"))
    return cfg


def test_0015_up_and_down(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "ledger.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db_path))
    from investment_dashboard.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    cfg = _cfg()
    command.upgrade(cfg, "c1f5a3b9e2d4")
    engine = sa.create_engine(f"sqlite:///{db_path.as_posix()}")
    assert "fx_conversions" not in sa.inspect(engine).get_table_names()

    command.upgrade(cfg, "d2a6b4c8e1f0")
    insp = sa.inspect(engine)
    assert "fx_conversions" in insp.get_table_names()
    cols = {c["name"] for c in insp.get_columns("fx_conversions")}
    assert cols == {
        "id",
        "date",
        "eur_sent",
        "usd_received",
        "fees_eur",
        "note",
        "created_at",
        "updated_at",
    }

    command.downgrade(cfg, "c1f5a3b9e2d4")
    assert "fx_conversions" not in sa.inspect(engine).get_table_names()
    engine.dispose()
    get_settings.cache_clear()  # type: ignore[attr-defined]
