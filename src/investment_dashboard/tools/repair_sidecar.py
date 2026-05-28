"""``repair-sidecar`` CLI — integrity-check and remove stray WAL/SHM files.

Usage::

    python -m investment_dashboard.tools.repair_sidecar /path/to/ledger.sqlite

Implements the v2.0 plan §5.2 repair flow. The tool is safe to run
against a database that has *no* stray sidecars (it's a no-op).
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from investment_dashboard.storage.encryption import resolve_encryption
from investment_dashboard.storage.sidecar import (
    StraySidecarError,
    repair_sidecars,
    scan_sidecars,
)

log = logging.getLogger(__name__)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="investment_dashboard.tools.repair_sidecar")
    p.add_argument("db", type=Path, help="Path to the SQLite file to repair.")
    p.add_argument(
        "--passphrase",
        default=None,
        help=("SQLCipher passphrase. If omitted, reads INV_DASHBOARD_DB_PASSPHRASE."),
    )
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    db: Path = args.db
    if not db.exists():
        log.error("file not found: %s", db)
        return 2
    before = scan_sidecars(db)
    if not before.found:
        log.info("no stray sidecars next to %s; nothing to do", db)
        return 0
    passphrase = args.passphrase or os.environ.get("INV_DASHBOARD_DB_PASSPHRASE")
    encryption = resolve_encryption(
        encrypt_synced_tiers=bool(passphrase),
        env_passphrase=passphrase,
    )
    try:
        after = repair_sidecars(db, encryption=encryption)
    except StraySidecarError as exc:
        log.error("repair failed: %s", exc)
        return 3
    if after.found:  # pragma: no cover - filesystem races
        log.warning("some sidecars survived: wal=%s shm=%s", after.wal, after.shm)
        return 1
    log.info("sidecars removed for %s", db)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
