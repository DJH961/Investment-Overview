"""``export-snapshot`` CLI — write the mobile read-model snapshot to a file.

This is the "option (d)" delivery path: instead of the phone reaching a
live server, the laptop periodically writes the full JSON snapshot into a
folder that the user's consumer-cloud auto-sync app (OneDrive, iCloud,
Dropbox, Google Drive) already mirrors. The phone reads the freshest
synced copy offline — same data, local feel, no always-on server.

The snapshot is identical to what the live API serves (both call
:func:`investment_dashboard.readmodels.build_snapshot`), so the two
delivery channels can never diverge.

Usage::

    # Write to the default location (beside the config tier):
    inv-dashboard-export-snapshot

    # Custom path, refreshing FX/prices first:
    inv-dashboard-export-snapshot --output /path/to/Dropbox/portfolio.json --refresh
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

log = logging.getLogger(__name__)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="inv-dashboard-export-snapshot")
    p.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Destination JSON path. Defaults to settings.resolved_snapshot_path.",
    )
    p.add_argument(
        "--refresh",
        action="store_true",
        help="Refresh FX rates and prices from the network before exporting.",
    )
    p.add_argument(
        "--indent",
        type=int,
        default=None,
        help="Pretty-print with this indent. Default writes compact JSON.",
    )
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def _atomic_write(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` via a temp file + rename.

    Avoids the cloud-sync agent ever uploading a half-written file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    # Imported lazily so ``--help`` stays fast and import side effects
    # (engine creation, boot) only happen when actually exporting.
    from investment_dashboard.boot import run_boot_sequence  # noqa: PLC0415
    from investment_dashboard.config import get_settings  # noqa: PLC0415
    from investment_dashboard.db import session_scope  # noqa: PLC0415
    from investment_dashboard.readmodels import build_snapshot  # noqa: PLC0415

    run_boot_sequence(skip_network=not args.refresh)

    settings = get_settings()
    output: Path = args.output or settings.resolved_snapshot_path

    with session_scope() as session:
        snapshot = build_snapshot(session)

    _atomic_write(output, json.dumps(snapshot, indent=args.indent))
    log.info("snapshot written: %s", output)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
