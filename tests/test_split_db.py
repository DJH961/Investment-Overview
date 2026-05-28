"""Tests for the one-shot split_db CLI."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
import sqlalchemy as sa

from investment_dashboard.models import (
    Account,
    Instrument,
    InstrumentOverride,
    PriceHistory,
)
from investment_dashboard.models.base import ALL_METADATAS
from investment_dashboard.tools.split_db import SplitDbError, main, split_db


def _seed_source(path: Path) -> None:
    """Create a unified single-file DB with one row in each tier."""
    eng = sa.create_engine(f"sqlite:///{path.as_posix()}", future=True)
    for md in ALL_METADATAS:
        md.create_all(eng)
    factory = sa.orm.sessionmaker(bind=eng)
    with factory() as s:
        s.add(
            Account(
                broker="fidelity",
                account_label="F",
                native_currency="USD",
                account_type="brokerage",
            )
        )
        instr = Instrument(symbol="VTI", name="Total US", asset_class="etf", native_currency="USD")
        s.add(instr)
        s.flush()
        s.add(InstrumentOverride(instrument_id=instr.id, category="US Stocks", active=True))
        s.add(
            PriceHistory(
                instrument_id=instr.id,
                date=date(2024, 1, 1),
                close_native=Decimal("230.00"),
            )
        )
        s.commit()
    eng.dispose()


def test_split_db_routes_each_table_to_its_tier(tmp_path: Path) -> None:
    source = tmp_path / "db.sqlite"
    _seed_source(source)
    ledger = tmp_path / "ledger.sqlite"
    config = tmp_path / "config.sqlite"
    cache = tmp_path / "cache.sqlite"
    counts = split_db(source, ledger=ledger, config=config, cache=cache)
    assert counts["ledger"] >= 2  # accounts + instruments
    assert counts["config"] >= 1  # instrument_overrides
    assert counts["cache"] >= 1  # price_history

    def _table_names(p: Path) -> set[str]:
        eng = sa.create_engine(f"sqlite:///{p.as_posix()}", future=True)
        with eng.connect() as conn:
            rows = conn.execute(sa.text("SELECT name FROM sqlite_master WHERE type='table'")).all()
        eng.dispose()
        return {r[0] for r in rows}

    ledger_tables = _table_names(ledger)
    config_tables = _table_names(config)
    cache_tables = _table_names(cache)
    assert "accounts" in ledger_tables
    assert "instruments" in ledger_tables
    assert "accounts" not in cache_tables
    assert "instrument_overrides" in config_tables
    assert "instrument_overrides" not in ledger_tables
    assert "price_history" in cache_tables
    assert "price_history" not in ledger_tables


def test_split_db_refuses_to_overwrite(tmp_path: Path) -> None:
    source = tmp_path / "db.sqlite"
    _seed_source(source)
    ledger = tmp_path / "ledger.sqlite"
    ledger.write_text("dummy")
    with pytest.raises(SplitDbError, match="refusing to overwrite"):
        split_db(
            source,
            ledger=ledger,
            config=tmp_path / "config.sqlite",
            cache=tmp_path / "cache.sqlite",
        )


def test_split_db_cli_returns_zero_on_success(tmp_path: Path) -> None:
    source = tmp_path / "db.sqlite"
    _seed_source(source)
    rc = main(
        [
            "--from",
            str(source),
            "--ledger",
            str(tmp_path / "ledger.sqlite"),
            "--config",
            str(tmp_path / "config.sqlite"),
            "--cache",
            str(tmp_path / "cache.sqlite"),
        ]
    )
    assert rc == 0


def test_split_db_missing_source(tmp_path: Path) -> None:
    rc = main(
        [
            "--from",
            str(tmp_path / "nope.sqlite"),
            "--ledger",
            str(tmp_path / "l.sqlite"),
            "--config",
            str(tmp_path / "c.sqlite"),
            "--cache",
            str(tmp_path / "ca.sqlite"),
        ]
    )
    assert rc == 2
