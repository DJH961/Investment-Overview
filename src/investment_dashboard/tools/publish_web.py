"""``publish-web`` CLI — encrypt + publish the live-web companion blob.

Mirror of ``inv-dashboard-export-snapshot`` for the v3.0 live-web companion
(``docs/v3.0_live_web_companion_proposal.md`` §5.7). It builds the minimized
mobile export, seals it into an AES-256-GCM envelope under the mobile
passphrase, and overwrites the single ``portfolio.enc`` asset on the configured
GitHub release.

Usage::

    # Publish using settings/keyring (repo, tag, token, passphrase):
    inv-dashboard-publish-web

    # Refresh FX/prices first, then publish:
    inv-dashboard-publish-web --refresh

    # Dry run — write the encrypted blob to a local file instead of GitHub:
    inv-dashboard-publish-web --output portfolio.enc

Secrets (the GitHub PAT and the mobile passphrase) are read from the OS keyring
or the ``INV_DASHBOARD_PUBLISH_TOKEN`` / ``INV_DASHBOARD_MOBILE_PASSPHRASE``
environment variables — never passed on the command line, so they don't leak
into shell history or the process table.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

log = logging.getLogger(__name__)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="inv-dashboard-publish-web")
    p.add_argument(
        "--refresh",
        action="store_true",
        help="Refresh FX rates and prices from the network before publishing.",
    )
    p.add_argument(
        "--include-transactions",
        action="store_true",
        help="Include the transaction list in the export (larger blob).",
    )
    p.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help=(
            "Dry run: write the encrypted envelope to this path instead of "
            "uploading to GitHub. Useful for inspecting the blob or testing."
        ),
    )
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    # Imported lazily so ``--help`` stays fast and import side effects
    # (engine creation, boot) only happen when actually publishing.
    from investment_dashboard.boot import run_boot_sequence  # noqa: PLC0415
    from investment_dashboard.config import get_settings  # noqa: PLC0415
    from investment_dashboard.db import session_scope  # noqa: PLC0415
    from investment_dashboard.services import publish_service  # noqa: PLC0415

    run_boot_sequence(skip_network=not args.refresh)
    settings = get_settings()
    include_transactions = args.include_transactions or settings.publish_include_transactions

    if args.output is not None:
        passphrase = publish_service.resolve_mobile_passphrase(settings)
        if not passphrase:
            log.error(
                "No mobile passphrase available (set INV_DASHBOARD_MOBILE_PASSPHRASE "
                "or save one via Settings → Live web companion)."
            )
            return 2
        with session_scope() as session:
            envelope = publish_service.build_envelope(
                session,
                passphrase=passphrase,
                include_transactions=include_transactions,
            )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(envelope, separators=(",", ":")), encoding="utf-8")
        log.info("encrypted blob written: %s", args.output)
        return 0

    try:
        with session_scope() as session:
            result = publish_service.publish_now(
                session,
                settings=settings,
                include_transactions=include_transactions,
            )
    except publish_service.PublishError as exc:
        log.error("%s", exc)
        return 2

    log.info(
        "published %s (%d bytes) to %s@%s%s",
        result.asset_name,
        result.size_bytes,
        result.repo,
        result.release_tag,
        " (created release)" if result.created_release else "",
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
