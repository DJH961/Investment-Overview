"""Split a legacy single-file SQLite DB into three tier files.

Usage::

    python -m investment_dashboard.tools.split_db \\
        --from /path/to/db.sqlite \\
        --ledger /path/to/ledger.sqlite \\
        --config /path/to/config.sqlite \\
        --cache  /path/to/cache.sqlite

The tool is **read-only against the source**. It:

1. Verifies the source is a valid SQLite file (``PRAGMA
   integrity_check``).
2. Creates each tier file using SQLAlchemy ``create_all`` for the
   correct ``MetaData`` (LedgerBase / ConfigBase / CacheBase).
3. ``ATTACH``-es the source DB and copies the rows for every table in
   that tier with ``INSERT OR REPLACE``.
4. Re-runs ``PRAGMA integrity_check`` on every produced file.

The source DB is left untouched. After a successful split you can move
the files to their final locations and update
``INV_DASHBOARD_{LEDGER,CONFIG,CACHE}_PATH``.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import sqlalchemy as sa

from investment_dashboard.models.base import (
    CacheBase,
    ConfigBase,
    LedgerBase,
)

log = logging.getLogger(__name__)

_TIERS: dict[str, sa.MetaData] = {
    "ledger": LedgerBase.metadata,
    "config": ConfigBase.metadata,
    "cache": CacheBase.metadata,
}


class SplitDbError(RuntimeError):
    """Raised when the split cannot complete safely."""


def _check_integrity(url: str) -> None:
    eng = sa.create_engine(url, future=True)
    with eng.connect() as conn:
        result = conn.execute(sa.text("PRAGMA integrity_check")).scalar()
        if result != "ok":
            raise SplitDbError(f"integrity_check failed for {url}: {result!r}")
    eng.dispose()


def _copy_tier(source_path: Path, target_path: Path, metadata: sa.MetaData) -> int:
    """Create ``target_path`` and copy this tier's tables from source."""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    if target_path.exists():
        raise SplitDbError(
            f"refusing to overwrite existing file: {target_path} "
            "(delete it first or pick a different path)"
        )
    target_url = f"sqlite:///{target_path.as_posix()}"
    target_eng = sa.create_engine(target_url, future=True)
    metadata.create_all(target_eng)
    rows_copied = 0
    with target_eng.connect() as conn:
        conn.exec_driver_sql(f"ATTACH DATABASE '{source_path.as_posix()}' AS src")
        try:
            for table in metadata.sorted_tables:
                cols = ", ".join(f'"{c.name}"' for c in table.columns)
                sql = (
                    f'INSERT OR REPLACE INTO main."{table.name}" ({cols}) '
                    f'SELECT {cols} FROM src."{table.name}"'
                )
                try:
                    result = conn.exec_driver_sql(sql)
                except sa.exc.OperationalError as exc:
                    # Source may pre-date the current schema; warn and skip.
                    log.warning("skipping %s: %s", table.name, exc)
                    continue
                rows_copied += result.rowcount or 0
            conn.commit()
        finally:
            conn.exec_driver_sql("DETACH DATABASE src")
    target_eng.dispose()
    return rows_copied


def split_db(
    source: Path,
    *,
    ledger: Path,
    config: Path,
    cache: Path,
) -> dict[str, int]:
    """Run the split. Returns ``{tier: rows_copied}``."""
    if not source.exists():
        raise SplitDbError(f"source DB not found: {source}")
    source_url = f"sqlite:///{source.as_posix()}"
    _check_integrity(source_url)

    targets = {"ledger": ledger, "config": config, "cache": cache}
    counts: dict[str, int] = {}
    for tier, path in targets.items():
        counts[tier] = _copy_tier(source, path, _TIERS[tier])

    for tier, path in targets.items():
        _check_integrity(f"sqlite:///{path.as_posix()}")
        log.info("%s tier: %d rows -> %s", tier, counts[tier], path)
    return counts


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="investment_dashboard.tools.split_db")
    p.add_argument("--from", dest="source", type=Path, required=True)
    p.add_argument("--ledger", type=Path, required=True)
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--cache", type=Path, required=True)
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    try:
        counts = split_db(
            args.source,
            ledger=args.ledger,
            config=args.config,
            cache=args.cache,
        )
    except SplitDbError as exc:
        log.error("split aborted: %s", exc)
        return 2
    log.info("split complete: %s", counts)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
