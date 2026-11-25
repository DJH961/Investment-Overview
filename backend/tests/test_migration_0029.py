"""Migration 0029 (7.4, P19): snapshot EUR columns nullable, downgrade backfills them.

Synthetic rows only. Upgrade to 0029, store a snapshot and an intraday sample with a
NULL EUR column (EUR is derived from native USD / the stored rate), then downgrade to
0028: the NULLs are backfilled from ``usd / fx_eur_usd`` and ``NOT NULL`` comes back.
A row that cannot be backfilled (no USD or no rate) is cache data and is dropped.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from alembic import command

from test_migration_roundtrip import alembic_cfg

REV_0028 = "c4e8a2f6b0d7"
REV_0029 = "d9b3f1a7c2e5"


def _notnull(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(r[1] == column and r[3] == 1 for r in conn.execute(f'PRAGMA table_info("{table}")'))


def test_0029_round_trip_backfills_null_eur(tmp_path: Path) -> None:
    db = tmp_path / "p19.sqlite"
    cfg = alembic_cfg(db)
    command.upgrade(cfg, REV_0029)

    conn = sqlite3.connect(db)
    assert not _notnull(conn, "position_snapshots", "total_value_eur")
    assert not _notnull(conn, "intraday_value", "market_value_eur")
    # ``intraday_value.fx_eur_usd`` comes from the boot column guard, not a migration.
    conn.execute("ALTER TABLE intraday_value ADD COLUMN fx_eur_usd NUMERIC(12, 8)")
    conn.executescript(
        """
        INSERT INTO position_snapshots
            (snapshot_date, total_value_eur, total_value_usd, fx_eur_usd, computed_at)
            VALUES ('2026-11-02', NULL, 1250, 1.25, '2026-11-02 22:00:00'),
                   ('2026-11-03', 900, 1100, 1.10, '2026-11-03 22:00:00'),
                   ('2026-11-04', NULL, NULL, 1.10, '2026-11-04 22:00:00');
        INSERT INTO intraday_value (captured_at, market_value_eur, market_value_usd, fx_eur_usd)
            VALUES ('2026-11-03 15:00:00', NULL, 220, 1.10),
                   ('2026-11-03 15:05:00', NULL, 220, NULL);
        """
    )
    conn.commit()
    conn.close()

    command.downgrade(cfg, REV_0028)

    conn = sqlite3.connect(db)
    try:
        assert _notnull(conn, "position_snapshots", "total_value_eur")
        assert _notnull(conn, "intraday_value", "market_value_eur")
        snaps = dict(conn.execute("SELECT snapshot_date, total_value_eur FROM position_snapshots"))
        # 1250 / 1.25 = 1000; the stored 900 is kept; the row with no USD is dropped.
        assert set(snaps) == {"2026-11-02", "2026-11-03"}
        assert abs(float(snaps["2026-11-02"]) - 1000.0) < 1e-6
        assert float(snaps["2026-11-03"]) == 900.0
        samples = list(conn.execute("SELECT captured_at, market_value_eur FROM intraday_value"))
        assert len(samples) == 1
        assert abs(float(samples[0][1]) - 200.0) < 1e-6  # 220 / 1.10
    finally:
        conn.close()

    # ...and the schema climbs back to head.
    command.upgrade(cfg, "head")
