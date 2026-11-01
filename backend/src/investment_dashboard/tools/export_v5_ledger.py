"""``inv-dashboard-export-v5``: turn the v6 server DB back into v5 files (rollback kit).

Usage (inside the container, or anywhere with a SQLCipher driver)::

    inv-dashboard-export-v5 --db app.sqlite --out ./v5-export

Steps: decrypt a temporary copy -> ``alembic downgrade`` to the v5 head
(``0014``) -> split into v5's ``ledger.sqlite`` + ``config.sqlite`` (config
tables as in ``models.base.ConfigBase``; cache-tier rows are emptied, v5
rebuilds prices/FX itself) -> check both files open with v5's schema -> write
them to ``--out``. The input file is never modified and existing files in
``--out`` are never overwritten.

Data that only exists in v6 (``fx_conversions``, login credentials) is dropped
by the downgrade: v5 has no place for it.

The key comes from ``INV_DASHBOARD_DB_PASSPHRASE`` or a hidden prompt.
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sqlite3
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from investment_dashboard.db import _CACHE_TABLES
from investment_dashboard.models.base import ConfigBase, LedgerBase
from investment_dashboard.tools.upload_db import (
    _find_alembic_ini,
    _integrity,
    _merge_tier,
    _row_counts,
    _tables,
)

log = logging.getLogger(__name__)

#: Alembic revision of migration 0014, the last v5 schema.
V5_HEAD = "c1f5a3b9e2d4"


class ExportV5Error(RuntimeError):
    """Raised when the v5 export cannot be produced safely."""


@dataclass
class ExportResult:
    """What :func:`export_v5` wrote."""

    ledger: Path
    config: Path
    counts: dict[str, int] = field(default_factory=dict)


def _decrypt_copy(src: Path, dest: Path, passphrase: str | None) -> None:
    """Write a plain SQLite copy of ``src`` to ``dest`` (``src`` stays untouched)."""
    if passphrase is None:
        # Plain input (tests, or a DB that was never encrypted): backup API copy.
        s = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)
        d = sqlite3.connect(dest)
        try:
            s.backup(d)
        finally:
            d.close()
            s.close()
        return

    from investment_dashboard.storage import encryption as enc  # noqa: PLC0415

    driver = enc._detect_driver()
    if driver is None:
        raise enc.EncryptionUnavailableError(
            "No SQLCipher driver here. Run this tool inside the container instead."
        )
    conn = enc.connect_sqlite(src, enc.EncryptionConfig(True, driver, passphrase))
    try:
        try:
            conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        except Exception as exc:
            raise ExportV5Error("cannot read the database: wrong passphrase?") from exc
        conn.execute("ATTACH DATABASE ? AS plain KEY ''", (str(dest),))
        conn.execute("SELECT sqlcipher_export('plain')")
        conn.execute("DETACH DATABASE plain")
        conn.commit()
    finally:
        conn.close()


def _downgrade_to_v5(db: Path) -> None:
    from alembic import command  # noqa: PLC0415
    from alembic.config import Config  # noqa: PLC0415

    ini = _find_alembic_ini()
    cfg = Config(str(ini))
    cfg.set_main_option("script_location", str(ini.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db.as_posix()}")
    cfg.attributes["embedded"] = True
    command.downgrade(cfg, V5_HEAD)
    conn = sqlite3.connect(db)
    try:
        row = conn.execute("SELECT version_num FROM alembic_version").fetchone()
    finally:
        conn.close()
    if not row or row[0] != V5_HEAD:
        raise ExportV5Error(f"downgrade did not reach the v5 head ({row!r})")


def _empty_non_ledger_tables(ledger: Path, config_tables: set[str]) -> None:
    """Keep the v5 ledger schema, but only ledger rows (config moves, cache is rebuilt)."""
    conn = sqlite3.connect(ledger)
    try:
        for name in _tables(conn) & (config_tables | _CACHE_TABLES):
            conn.execute(f'DELETE FROM "{name}"')
        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()


def _check_v5_schema(ledger: Path, config: Path) -> None:
    for path in (ledger, config):
        _integrity(path)
    conn = sqlite3.connect(ledger)
    try:
        version = conn.execute("SELECT version_num FROM alembic_version").fetchone()
        have = _tables(conn)
        fk = conn.execute("PRAGMA foreign_key_check").fetchall()
    finally:
        conn.close()
    if not version or version[0] != V5_HEAD:
        raise ExportV5Error(f"ledger is not at the v5 schema revision ({version!r})")
    missing = {"accounts", "instruments", "transactions"} - have
    if missing:
        raise ExportV5Error(f"ledger is missing tables: {sorted(missing)}")
    if "fx_conversions" in have:
        raise ExportV5Error("ledger still has the v6-only table fx_conversions")
    if fk:
        raise ExportV5Error(f"foreign key violations in ledger: {fk[:3]}")
    conn = sqlite3.connect(config)
    try:
        cfg_have = _tables(conn)
    finally:
        conn.close()
    needed = {t.name for t in ConfigBase.metadata.sorted_tables} & {
        "app_config",
        "instrument_overrides",
        "target_allocations",
        "target_allocation_items",
    }
    if needed - cfg_have:
        raise ExportV5Error(f"config is missing tables: {sorted(needed - cfg_have)}")


def export_v5(*, db: Path, out_dir: Path, passphrase: str | None = None) -> ExportResult:
    """Write ``ledger.sqlite`` + ``config.sqlite`` (v5 schema) into ``out_dir``."""
    if not db.is_file():
        raise ExportV5Error(f"database not found: {db}")
    out_dir = out_dir.resolve()
    ledger_out, config_out = out_dir / "ledger.sqlite", out_dir / "config.sqlite"
    for target in (ledger_out, config_out):
        if target.exists():
            raise ExportV5Error(f"refusing to overwrite {target}")
    if db.resolve() in {ledger_out.resolve(), config_out.resolve()}:
        raise ExportV5Error("--out must not contain the input file")

    with tempfile.TemporaryDirectory(prefix="inv-export-v5-") as tmp_s:
        tmp = Path(tmp_s)
        work = tmp / "work.sqlite"
        _decrypt_copy(db, work, passphrase)
        _integrity(work)
        _downgrade_to_v5(work)

        config_tmp = tmp / "config.sqlite"
        _merge_tier(config_tmp, work, ConfigBase.metadata)
        config_names = {t.name for t in ConfigBase.metadata.sorted_tables}
        ledger_names = {t.name for t in LedgerBase.metadata.sorted_tables}
        _empty_non_ledger_tables(work, config_names - ledger_names)

        for path in (work, config_tmp):
            c = sqlite3.connect(path)
            try:
                c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                c.execute("PRAGMA journal_mode=DELETE")
            finally:
                c.close()
        _check_v5_schema(work, config_tmp)

        out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(work, ledger_out)
        shutil.copy2(config_tmp, config_out)

    counts: dict[str, int] = {}
    for path in (ledger_out, config_out):
        conn = sqlite3.connect(path)
        try:
            counts.update({f"{path.stem}.{k}": v for k, v in _row_counts(conn).items()})
        finally:
            conn.close()
    return ExportResult(ledger=ledger_out, config=config_out, counts=counts)


# --------------------------------------------------------------------------- CLI


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="inv-dashboard-export-v5", description=__doc__)
    p.add_argument("--db", type=Path, required=True, help="the v6 server DB (SQLCipher)")
    p.add_argument("--out", type=Path, required=True, help="folder for ledger/config.sqlite")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    from investment_dashboard.tools._passphrase import resolve_passphrase  # noqa: PLC0415

    passphrase = resolve_passphrase(None, prompt="Server DB passphrase: ")
    if not passphrase:
        print("export-v5 aborted: no passphrase (INV_DASHBOARD_DB_PASSPHRASE)", file=sys.stderr)
        return 2
    try:
        res = export_v5(db=args.db, out_dir=args.out, passphrase=passphrase)
    except ExportV5Error as exc:
        print(f"export-v5 aborted: {exc}", file=sys.stderr)
        return 2
    except RuntimeError as exc:  # EncryptionUnavailableError
        print(f"export-v5 aborted: {exc}", file=sys.stderr)
        return 3
    print(f"Wrote {res.ledger} and {res.config} (v5 schema {V5_HEAD}).")
    for name in ("accounts", "instruments", "transactions"):
        print(f"  {name}: {res.counts.get(f'ledger.{name}', 0)}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
