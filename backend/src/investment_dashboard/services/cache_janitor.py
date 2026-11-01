"""Cache-tier janitor.

When the storage tiers live in separate SQLite files (rework v2.0),
SQLite can no longer enforce a foreign key between cache rows and the
ledger ``instruments`` table. This module drops cache rows whose
``instrument_id`` no longer exists on the ledger side. It is safe to
run at boot — it only deletes derived data.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from investment_dashboard.repositories import instruments_repo, maintenance_repo

log = logging.getLogger(__name__)


def cleanup_orphan_cache_rows(ledger_session: Session, cache_session: Session) -> dict[str, int]:
    """Delete cache rows whose ``instrument_id`` is not on the ledger.

    Returns a dict of ``{table_name: rows_deleted}``. ``FxHistory`` has
    no instrument link and is never touched.
    """
    live_ids = instruments_repo.list_ids(ledger_session)
    deleted = maintenance_repo.delete_orphan_instrument_rows(cache_session, live_ids)
    if any(deleted.values()):
        log.info("cache-orphan janitor removed %s", deleted)
    return deleted
