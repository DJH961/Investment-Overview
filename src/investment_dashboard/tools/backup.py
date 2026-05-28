"""``backup`` CLI — snapshot and verify the ledger/config tiers.

Usage::

    # Snapshot only:
    python -m investment_dashboard.tools.backup /path/to/ledger.sqlite

    # Snapshot + verify (integrity_check + row-count manifest):
    python -m investment_dashboard.tools.backup --verify /path/to/ledger.sqlite

Implements the v2.0 plan §5.4 ``backup --verify`` flow.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from investment_dashboard.storage.backup import snapshot, verify_backup
from investment_dashboard.storage.integrity import IntegrityCheckFailed

log = logging.getLogger(__name__)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="investment_dashboard.tools.backup")
    p.add_argument("db", type=Path, help="Path to the SQLite file to back up.")
    p.add_argument(
        "--verify",
        action="store_true",
        help="Integrity-check the resulting backup and print per-table row counts.",
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
    out = snapshot(db)
    if out is None:
        log.error("%s does not exist; nothing to back up", db)
        return 2
    log.info("backup written: %s", out)
    if not args.verify:
        return 0
    try:
        counts = verify_backup(out)
    except IntegrityCheckFailed as exc:
        log.error("backup verification FAILED: %s", exc)
        return 3
    manifest_path = out.with_suffix(out.suffix + ".manifest.json")
    manifest_path.write_text(json.dumps({"counts": counts}, indent=2))
    log.info("verified backup: %s", manifest_path)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
