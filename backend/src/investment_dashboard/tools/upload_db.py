"""``inv-dashboard-upload-db``: prepare the v5 ledger for the v6 server.

Usage (on the laptop, or inside the container if no SQLCipher driver is
installed)::

    inv-dashboard-upload-db --ledger ledger.sqlite --config config.sqlite \\
        --out app.sqlite

The originals are never modified: everything happens on copies in a temp
directory. Steps: integrity check -> ``alembic upgrade head`` on the ledger
copy -> merge the config tier (and the cache tier with ``--cache``) into it ->
prune unused instruments / empty accounts -> write one SQLCipher-encrypted
file -> reopen it with the key and compare table row counts.

The key comes from ``INV_DASHBOARD_DB_PASSPHRASE`` or a hidden prompt, never
from the command line. The tool never talks to the server; it prints the
commands for the owner to run.
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
from typing import Any

import sqlalchemy as sa

from investment_dashboard.models.base import CacheBase, ConfigBase

log = logging.getLogger(__name__)

SCP = "/c/Windows/System32/OpenSSH/scp.exe"
SSH = "/c/Windows/System32/OpenSSH/ssh.exe"


class UploadDbError(RuntimeError):
    """Raised when the upload file cannot be prepared safely."""


@dataclass
class UploadResult:
    """What :func:`prepare_upload` did."""

    output: Path
    revision: str
    encrypted: bool
    counts: dict[str, int] = field(default_factory=dict)
    pruned_instruments: list[str] = field(default_factory=list)
    kept_instruments: list[str] = field(default_factory=list)
    pruned_accounts: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- helpers


def _integrity(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        res = conn.execute("PRAGMA integrity_check").fetchone()
    finally:
        conn.close()
    if not res or res[0] != "ok":
        raise UploadDbError(f"integrity_check failed for {path.name}: {res!r}")


def _find_alembic_ini() -> Path:
    here = Path(__file__).resolve()
    for cand in (here.parents[3] / "alembic.ini", Path.cwd() / "alembic.ini"):
        if cand.exists():
            return cand
    raise UploadDbError("alembic.ini not found (run from the backend/ directory)")


def _upgrade_head(db: Path) -> str:
    from alembic import command  # noqa: PLC0415
    from alembic.config import Config  # noqa: PLC0415
    from alembic.script import ScriptDirectory  # noqa: PLC0415

    ini = _find_alembic_ini()
    cfg = Config(str(ini))
    cfg.set_main_option("script_location", str(ini.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db.as_posix()}")
    cfg.attributes["embedded"] = True
    command.upgrade(cfg, "head")
    head = ScriptDirectory.from_config(cfg).get_current_head()
    conn = sqlite3.connect(db)
    try:
        row = conn.execute("SELECT version_num FROM alembic_version").fetchone()
    finally:
        conn.close()
    if not row or row[0] != head:
        raise UploadDbError(f"migration did not reach head ({row!r} != {head!r})")
    return str(head)


def _tables(conn: sqlite3.Connection, schema: str = "main") -> set[str]:
    rows = conn.execute(
        f"SELECT name FROM {schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {r[0] for r in rows}


def _columns(conn: sqlite3.Connection, schema: str, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f'PRAGMA {schema}.table_info("{table}")').fetchall()]


def _merge_tier(target: Path, source: Path, metadata: sa.MetaData) -> None:
    """Copy this tier's tables from ``source`` into ``target`` (common columns)."""
    eng = sa.create_engine(f"sqlite:///{target.as_posix()}", future=True)
    metadata.create_all(eng)  # no-op for tables migrations already made
    eng.dispose()
    conn = sqlite3.connect(target)
    try:
        conn.execute("ATTACH DATABASE ? AS src", (str(source),))
        src_tables = _tables(conn, "src")
        for table in metadata.sorted_tables:
            if table.name not in src_tables:
                continue
            common = [
                c
                for c in _columns(conn, "main", table.name)
                if c in set(_columns(conn, "src", table.name))
            ]
            cols = ", ".join(f'"{c}"' for c in common)
            conn.execute(
                f'INSERT OR REPLACE INTO main."{table.name}" ({cols}) '
                f'SELECT {cols} FROM src."{table.name}"'
            )
        conn.commit()
        conn.execute("DETACH DATABASE src")
    finally:
        conn.close()


def _prune(db: Path) -> tuple[list[str], list[str], list[str]]:
    """Delete unused instruments and empty accounts. Returns (pruned, kept, accounts)."""
    conn = sqlite3.connect(db)
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        tables = _tables(conn)
        used = {r[0] for r in conn.execute("SELECT DISTINCT instrument_id FROM transactions")}
        protected: set[int] = set()
        if "target_allocation_items" in tables:
            protected = {
                r[0]
                for r in conn.execute("SELECT DISTINCT instrument_id FROM target_allocation_items")
            }
        pruned: list[str] = []
        kept: list[str] = []
        for iid, symbol in conn.execute("SELECT id, symbol FROM instruments").fetchall():
            if iid in used:
                continue
            if iid in protected:
                kept.append(f"{symbol} (in a target allocation)")
                continue
            pruned.append(symbol)
            if "instrument_overrides" in tables:
                conn.execute("DELETE FROM instrument_overrides WHERE instrument_id=?", (iid,))
            conn.execute("DELETE FROM instruments WHERE id=?", (iid,))
        accounts = [
            f"{broker}/{label}"
            for aid, broker, label in conn.execute(
                "SELECT id, broker, account_label FROM accounts "
                "WHERE id NOT IN (SELECT DISTINCT account_id FROM transactions)"
            ).fetchall()
        ]
        conn.execute(
            "DELETE FROM accounts WHERE id NOT IN (SELECT DISTINCT account_id FROM transactions)"
        )
        conn.commit()
    finally:
        conn.close()
    return pruned, kept, accounts


def _row_counts(conn: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    for (name,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall():
        out[name] = int(conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0])
    return out


def _encrypt(plain: Path, out: Path, passphrase: str) -> None:
    from investment_dashboard.storage import encryption as enc  # noqa: PLC0415

    driver = enc._detect_driver()
    if driver is None:
        raise enc.EncryptionUnavailableError(
            "No SQLCipher driver here. Run this tool inside the container instead:\n"
            "  docker compose run --rm -v <folder-with-your-copies>:/in app "
            "inv-dashboard-upload-db --ledger /in/ledger.sqlite --config /in/config.sqlite "
            "--out /in/app.sqlite"
        )
    dbapi = enc._sqlcipher_dbapi(driver)
    if out.exists():
        out.unlink()
    conn = dbapi.connect(str(plain))
    try:
        cur = conn.cursor()
        cur.execute(
            f"ATTACH DATABASE ? AS enc KEY {enc.sql_string_literal(passphrase)}", (str(out),)
        )
        cur.execute("SELECT sqlcipher_export('enc')")
        cur.execute("DETACH DATABASE enc")
        conn.commit()
    finally:
        conn.close()


def _verify_encrypted(out: Path, passphrase: str, expected: dict[str, int]) -> None:
    from investment_dashboard.storage import encryption as enc  # noqa: PLC0415

    cfg = enc.EncryptionConfig(True, enc._detect_driver(), passphrase)
    conn = enc.connect_sqlite(out, cfg)
    try:
        res = conn.execute("PRAGMA integrity_check").fetchone()
        if not res or res[0] != "ok":
            raise UploadDbError(f"encrypted output failed integrity_check: {res!r}")
        got = _row_counts(conn)
    finally:
        conn.close()
    if got != expected:
        diff = {
            k: (expected.get(k), got.get(k))
            for k in set(expected) | set(got)
            if expected.get(k) != got.get(k)
        }
        raise UploadDbError(f"row counts differ after encryption: {diff}")


# --------------------------------------------------------------------------- main API


def prepare_upload(
    *,
    ledger: Path,
    config: Path,
    out: Path,
    cache: Path | None = None,
    passphrase: str | None = None,
    prune: bool = True,
    encrypt: bool = True,
) -> UploadResult:
    """Build the single-file server DB at ``out``. Originals are never modified.

    With ``encrypt=False`` the output is a plain SQLite file (tests, and the CLI's
    ``--local-only --plain`` laptop trial; the server copy is always encrypted).
    """
    for label, path in (("ledger", ledger), ("config", config), ("cache", cache)):
        if path is not None and not path.is_file():
            raise UploadDbError(f"{label} file not found: {path}")
    if encrypt and not passphrase:
        raise UploadDbError("no passphrase: set INV_DASHBOARD_DB_PASSPHRASE or use the prompt")
    out = out.resolve()
    if out in {ledger.resolve(), config.resolve()} or (cache and out == cache.resolve()):
        raise UploadDbError("--out must not be one of the input files")

    with tempfile.TemporaryDirectory(prefix="inv-upload-") as tmp_s:
        tmp = Path(tmp_s)
        work = {"ledger": tmp / "ledger.sqlite", "config": tmp / "config.sqlite"}
        shutil.copy2(ledger, work["ledger"])
        shutil.copy2(config, work["config"])
        if cache is not None:
            work["cache"] = tmp / "cache.sqlite"
            shutil.copy2(cache, work["cache"])
        for path in work.values():
            _integrity(path)

        revision = _upgrade_head(work["ledger"])
        _merge_tier(work["ledger"], work["config"], ConfigBase.metadata)
        if "cache" in work:
            _merge_tier(work["ledger"], work["cache"], CacheBase.metadata)

        result = UploadResult(output=out, revision=revision, encrypted=encrypt)
        if prune:
            result.pruned_instruments, result.kept_instruments, result.pruned_accounts = _prune(
                work["ledger"]
            )

        merged = work["ledger"]
        conn = sqlite3.connect(merged)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.execute("PRAGMA journal_mode=DELETE")
            result.counts = _row_counts(conn)
        finally:
            conn.close()
        _integrity(merged)

        out.parent.mkdir(parents=True, exist_ok=True)
        if encrypt:
            assert passphrase is not None
            _encrypt(merged, out, passphrase)
            _verify_encrypted(out, passphrase, result.counts)
        else:
            shutil.copy2(merged, out)
    return result


# --------------------------------------------------------------------------- CLI


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="inv-dashboard-upload-db", description=__doc__)
    p.add_argument("--ledger", type=Path, required=True, help="v5 ledger.sqlite (plain)")
    p.add_argument("--config", type=Path, required=True, help="v5 config.sqlite (plain)")
    p.add_argument("--cache", type=Path, default=None, help="optional v5 cache.sqlite")
    p.add_argument("--out", type=Path, required=True, help="encrypted file to write")
    p.add_argument("--no-prune", action="store_true", help="keep unused instruments/accounts")
    p.add_argument(
        "--local-only",
        action="store_true",
        help="print the steps for running the app on this laptop instead of the server upload",
    )
    p.add_argument(
        "--plain",
        action="store_true",
        help="with --local-only: write an unencrypted file (laptop trial without a SQLCipher driver)",
    )
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def _print_summary(res: UploadResult, *, local_only: bool = False) -> None:
    print(f"Wrote {res.output} (schema revision {res.revision}, encrypted={res.encrypted})")
    for name in ("accounts", "instruments", "transactions"):
        if name in res.counts:
            print(f"  {name}: {res.counts[name]}")
    if res.pruned_instruments:
        print("Pruned instruments: " + ", ".join(res.pruned_instruments))
    if res.kept_instruments:
        print("Kept despite no transactions: " + ", ".join(res.kept_instruments))
    if res.pruned_accounts:
        print("Pruned accounts (no transactions): " + ", ".join(res.pruned_accounts))
    if local_only:
        print(
            "\nNext (details in deploy/RUNBOOK.md, 'Try it before the server'): point the "
            "app at this file and start it on this laptop, e.g. with deploy/try_local.ps1:\n"
            f"  INV_DASHBOARD_DB_PATH={res.output.as_posix()}\n"
            + (
                "  INV_DASHBOARD_DB_PASSPHRASE=<the same passphrase>\n"
                if res.encrypted
                else "  INV_DASHBOARD_ENCRYPT_SYNCED_TIERS=false\n"
            )
            + "  uv run inv-dashboard-server\n"
            "Nothing was sent anywhere."
        )
        return
    print(
        "\nNext (details in deploy/RUNBOOK.md, 'Uploading the ledger'). From Git Bash:\n"
        f"  {SCP} {res.output.as_posix()} daniel@hetzner-djh-v1:/tmp/app.sqlite\n"
        f"  {SSH} daniel@hetzner-djh-v1\n"
        "On the server:\n"
        "  cd /opt/investments && docker compose stop app\n"
        "  docker compose run --rm --no-deps -v /tmp/app.sqlite:/in/app.sqlite:ro "
        "--entrypoint sh app -c "
        "'cp /in/app.sqlite /data/app.sqlite && rm -f /data/app.sqlite-wal /data/app.sqlite-shm'\n"
        "  rm /tmp/app.sqlite && docker compose up -d app"
    )


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    from investment_dashboard.tools._passphrase import resolve_passphrase  # noqa: PLC0415

    if args.plain and not args.local_only:
        print("upload-db aborted: --plain is only for --local-only", file=sys.stderr)
        return 2
    passphrase = None if args.plain else resolve_passphrase(None, prompt="Server DB passphrase: ")
    try:
        res = prepare_upload(
            ledger=args.ledger,
            config=args.config,
            cache=args.cache,
            out=args.out,
            passphrase=passphrase,
            prune=not args.no_prune,
            encrypt=not args.plain,
        )
    except UploadDbError as exc:
        print(f"upload-db aborted: {exc}", file=sys.stderr)
        return 2
    except RuntimeError as exc:  # EncryptionUnavailableError
        print(f"upload-db aborted: {exc}", file=sys.stderr)
        return 3
    _print_summary(res, local_only=args.local_only)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
