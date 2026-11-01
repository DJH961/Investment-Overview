"""Tests for ``inv-dashboard-export-v5`` (plain SQLite fixtures, no SQLCipher)."""

from __future__ import annotations

import hashlib
import importlib.util
import sqlite3
from pathlib import Path

import pytest
from alembic import command

from investment_dashboard.db import _CACHE_TABLES
from investment_dashboard.tools import export_v5_ledger as ex

_spec = importlib.util.spec_from_file_location(
    "roundtrip_helpers", Path(__file__).parents[1] / "test_migration_roundtrip.py"
)
assert _spec is not None
assert _spec.loader is not None
rt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rt)

CONFIG = {
    "app_config",
    "instrument_overrides",
    "target_allocations",
    "target_allocation_items",
}


def _v6_db(tmp_path: Path) -> tuple[Path, dict[str, list[tuple]]]:
    db = tmp_path / "app.sqlite"
    rt.make_v5_fixture(db)
    before = rt.dump_rows(db)
    command.upgrade(rt.alembic_cfg(db), "head")
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO fx_conversions (date, eur_sent, usd_received) VALUES ('2024-01-05', 100, 108)"
    )
    conn.commit()
    conn.close()
    return db, before


def test_export_gives_identical_v5_rows(tmp_path: Path) -> None:
    db, before = _v6_db(tmp_path)
    digest = hashlib.sha256(db.read_bytes()).hexdigest()
    out = tmp_path / "out"
    res = ex.export_v5(db=db, out_dir=out)

    assert hashlib.sha256(db.read_bytes()).hexdigest() == digest  # input untouched
    ledger = rt.dump_rows(res.ledger)
    config = rt.dump_rows(res.config)
    for name in ("accounts", "instruments", "transactions"):
        assert ledger[name] == before[name]
    for name in CONFIG:
        assert config[name] == before[name]
        assert ledger[name] == []  # moved to config.sqlite
    for name in _CACHE_TABLES & set(ledger):
        assert ledger[name] == []  # cache is dropped, v5 rebuilds it
    assert "fx_conversions" not in ledger
    assert ledger["alembic_version"] == [(rt.V5_HEAD,)]


def test_export_refuses_to_overwrite(tmp_path: Path) -> None:
    db, _ = _v6_db(tmp_path)
    out = tmp_path / "out"
    ex.export_v5(db=db, out_dir=out)
    with pytest.raises(ex.ExportV5Error, match="overwrite"):
        ex.export_v5(db=db, out_dir=out)


def test_export_missing_input(tmp_path: Path) -> None:
    with pytest.raises(ex.ExportV5Error, match="not found"):
        ex.export_v5(db=tmp_path / "nope.sqlite", out_dir=tmp_path / "out")
