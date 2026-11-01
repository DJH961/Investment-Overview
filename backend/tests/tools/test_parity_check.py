"""Tests for the v5/v6 parity tool (synthetic ledger only)."""

from __future__ import annotations

import json
import shutil
import sqlite3
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from alembic import command

from investment_dashboard.tools import parity_check as pc

V5_HEAD = "c1f5a3b9e2d4"  # migration 0014
AS_OF = date(2024, 6, 3)


def _make_src(folder: Path) -> Path:
    """A v5-layout data dir: ledger (0014) + config + cache, tiny synthetic portfolio."""
    from alembic.config import Config

    from investment_dashboard.tools.upload_db import _find_alembic_ini

    folder.mkdir(parents=True)
    ledger = folder / "ledger.sqlite"
    ini = _find_alembic_ini()
    cfg = Config(str(ini))
    cfg.set_main_option("script_location", str(ini.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{ledger.as_posix()}")
    cfg.attributes["embedded"] = True
    command.upgrade(cfg, V5_HEAD)
    conn = sqlite3.connect(ledger)
    conn.executescript(
        """
        INSERT INTO accounts (id, broker, account_label, native_currency, active)
            VALUES (1, 'vanguard', 'Main', 'USD', 1);
        INSERT INTO instruments (id, symbol, name, asset_class, native_currency)
            VALUES (1, 'AAA', 'Fund A', 'etf', 'USD');
        INSERT INTO transactions (account_id, date, kind, instrument_id, quantity,
            price_native, gross_native, fees_native, net_native, fx_rate_to_eur, net_eur,
            net_usd, source)
            VALUES (1, '2024-01-02', 'deposit', NULL, NULL, NULL, NULL, NULL, 1000,
                    0.912, 912, 1000, 'manual'),
                   (1, '2024-01-02', 'buy', 1, 10, 100, 1000, 0, 1000, 0.912, 912, 1000,
                    'manual');
        INSERT INTO fx_history (date, base, quote, rate, source) VALUES
            ('2024-01-02', 'EUR', 'USD', 1.09650000, 'test'),
            ('2024-06-03', 'EUR', 'USD', 1.08000000, 'test');
        INSERT INTO price_history (instrument_id, date, close_native, source) VALUES
            (1, '2024-01-02', 100, 'test'), (1, '2024-03-28', 110, 'test'),
            (1, '2024-05-31', 120, 'test'), (1, '2024-06-03', 121, 'test');
        """
    )
    conn.commit()
    conn.close()
    for name in ("config.sqlite", "cache.sqlite"):
        shutil.copy2(ledger, folder / name)
    return folder


@pytest.fixture
def src(tmp_path: Path) -> Path:
    return _make_src(tmp_path / "live")


def test_snapshot_ledger_copies_and_leaves_source(src: Path, tmp_path: Path) -> None:
    before = (src / "ledger.sqlite").read_bytes()
    out = tmp_path / "copy"
    written = pc.snapshot_ledger(src, out)
    assert {p.name for p in written} == {"ledger.sqlite", "config.sqlite", "cache.sqlite"}
    conn = sqlite3.connect(out / "ledger.sqlite")
    assert conn.execute("SELECT count(*) FROM transactions").fetchone() == (2,)
    conn.close()
    assert (src / "ledger.sqlite").read_bytes() == before
    with pytest.raises(pc.ParityError, match="overwrite"):
        pc.snapshot_ledger(src, out)


def test_outputs_inside_repo_are_refused(src: Path) -> None:
    inside = Path(pc.__file__).resolve().parent / "parity_out"
    with pytest.raises(pc.ParityError, match="inside the repository"):
        pc.snapshot_ledger(src, inside)
    assert not inside.exists()
    assert pc.main(["dump", "--ledger", str(src), "--out", str(inside / "x.json")]) == 2


def test_dump_and_compare_with_planted_difference(src: Path, tmp_path: Path) -> None:
    copy = tmp_path / "copy"
    pc.snapshot_ledger(src, copy)
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    assert pc.main(["dump", "--ledger", str(copy), "--out", str(a), "--as-of", "2024-06-03"]) == 0
    assert pc.main(["dump", "--ledger", str(copy), "--out", str(b), "--as-of", "2024-06-03"]) == 0

    dump = json.loads(a.read_text(encoding="utf-8"))
    eur, usd = dump["currencies"]["EUR"], dump["currencies"]["USD"]
    assert "error" not in json.dumps(dump)
    assert pc._to_decimal(eur["totals"]["invested"]) == pytest.approx(912, abs=1)
    assert pc._to_decimal(usd["totals"]["invested"]) == pytest.approx(1000, abs=1)
    assert pc._to_decimal(usd["totals"]["value"]) == pytest.approx(1210, abs=1)  # 10 x 121
    pos = usd["instruments"]["vanguard/Main:AAA"]
    assert pos["shares"] == "10.00000000" or pc._to_decimal(pos["shares"]) == 10
    assert eur["deposits"]["total"] is not None

    # identical dumps: no differences
    assert pc.compare_dumps(dump, json.loads(b.read_text(encoding="utf-8"))) == []

    # plant one real difference, one within tolerance and one known v5 bug
    other = json.loads(b.read_text(encoding="utf-8"))
    other["currencies"]["EUR"]["totals"]["value"] = str(pc._to_decimal(eur["totals"]["value"]) + 5)
    other["currencies"]["EUR"]["totals"]["gain"] = str(
        pc._to_decimal(eur["totals"]["gain"]) + Decimal("0.005")
    )
    other["currencies"]["USD"]["returns"]["twr"] = "0.5"
    b.write_text(json.dumps(other), encoding="utf-8")

    report = tmp_path / "report.md"
    assert pc.main(["compare", str(a), str(b), "--out", str(report)]) == 0
    text = report.read_text(encoding="utf-8")
    unexplained, expected = text.split("## Expected differences")
    assert "currencies/EUR/totals/value" in unexplained
    assert "currencies/EUR/totals/gain" not in text  # within tolerance
    assert "currencies/USD/returns/twr" in expected
    assert "v5 bug 1" in expected
