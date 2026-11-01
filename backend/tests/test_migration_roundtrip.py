"""v5 (0014) -> head -> 0014 must give back identical rows in every table."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from alembic import command
from alembic.config import Config

from investment_dashboard.tools.upload_db import _find_alembic_ini

V5_HEAD = "c1f5a3b9e2d4"  # migration 0014, the last v5 revision


def alembic_cfg(db: Path) -> Config:
    ini = _find_alembic_ini()
    cfg = Config(str(ini))
    cfg.set_main_option("script_location", str(ini.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db.as_posix()}")
    cfg.attributes["embedded"] = True
    return cfg


def make_v5_fixture(path: Path) -> None:
    """A DB at 0014 with at least one row in every ledger/config/cache table."""
    command.upgrade(alembic_cfg(path), V5_HEAD)
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        INSERT INTO accounts (id, broker, account_label, native_currency, active)
            VALUES (1, 'vanguard', 'Main', 'USD', 1), (2, 'fidelity', 'Euro', 'EUR', 1);
        INSERT INTO instruments (id, symbol, name, asset_class, native_currency, expense_ratio)
            VALUES (1, 'AAA', 'Fund A', 'etf', 'USD', 0.00030),
                   (2, 'BBB', 'Fund B', 'stock', 'EUR', NULL);
        INSERT INTO transactions (id, account_id, date, kind, instrument_id, quantity,
            price_native, gross_native, fees_native, net_native, fx_rate_to_eur, net_eur,
            net_usd, description, external_id, source)
            VALUES (1, 1, '2024-01-02', 'buy', 1, 2.5, 100.123456, 250.308640, 1.5, 251.808640,
                    0.91, 229.15, 251.808640, 'first', 'x1', 'manual'),
                   (2, 1, '2024-02-01', 'deposit', NULL, NULL, NULL, NULL, NULL, 500,
                    0.92, 460, 500, NULL, NULL, 'manual');
        INSERT INTO app_config (key, value) VALUES ('display_currency', 'EUR');
        INSERT INTO instrument_overrides
            (instrument_id, category, active, name_override, asset_class_override,
             expense_ratio_override)
            VALUES (1, 'US Stocks', 1, 'Renamed', 'etf', 0.00050);
        INSERT INTO target_allocations (id, name, active, created_at, allow_sell, display_currency)
            VALUES (1, 'Plan', 1, '2024-01-01 00:00:00', 0, 'EUR');
        INSERT INTO target_allocation_items
            (target_allocation_id, instrument_id, weight_pct, no_buy) VALUES (1, 1, 60.5, 0);
        INSERT INTO fx_history (date, base, quote, rate, source)
            VALUES ('2024-01-02', 'EUR', 'USD', 1.09500000, 'frankfurter');
        INSERT INTO price_history (instrument_id, date, close_native, source)
            VALUES (1, '2024-01-02', 100.250000, 'yfinance');
        INSERT INTO price_split (instrument_id, date, ratio, source)
            VALUES (1, '2024-03-01', 2.00000000, 'yfinance');
        INSERT INTO price_cache_metadata (instrument_id, last_refreshed_at, price_market_time)
            VALUES (1, '2024-01-03 10:00:00', '2024-01-03 09:30:00');
        INSERT INTO position_snapshots (snapshot_date, total_value_eur, computed_at)
            VALUES ('2024-01-02', 229.150000, '2024-01-03 10:00:00');
        INSERT INTO intraday_value (captured_at, market_value_eur)
            VALUES ('2024-01-03 10:00:00', 230.000000);
        """
    )
    conn.commit()
    conn.close()


def dump_rows(path: Path, tables: set[str] | None = None) -> dict[str, list[tuple]]:
    conn = sqlite3.connect(path)
    try:
        names = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        ]
        out: dict[str, list[tuple]] = {}
        for n in sorted(names):
            if tables is not None and n not in tables:
                continue
            cols = sorted(r[1] for r in conn.execute(f'PRAGMA table_info("{n}")'))
            sel = ", ".join(f'"{c}"' for c in cols)
            out[n] = sorted(conn.execute(f'SELECT {sel} FROM "{n}"').fetchall(), key=repr)
        return out
    finally:
        conn.close()


def test_every_v5_table_has_fixture_rows(tmp_path: Path) -> None:
    db = tmp_path / "v5.sqlite"
    make_v5_fixture(db)
    empty = [n for n, rows in dump_rows(db).items() if not rows]
    assert empty == []


def test_upgrade_head_then_downgrade_restores_v5_rows(tmp_path: Path) -> None:
    db = tmp_path / "v5.sqlite"
    make_v5_fixture(db)
    before = dump_rows(db)
    cfg = alembic_cfg(db)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, V5_HEAD)
    assert dump_rows(db) == before
