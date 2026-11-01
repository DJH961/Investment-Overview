"""Cache-tier janitor.

When the storage tiers live in separate SQLite files (rework v2.0),
SQLite can no longer enforce a foreign key between cache rows and the
ledger ``instruments`` table. This module drops cache rows whose
``instrument_id`` no longer exists on the ledger side. It is safe to
run at boot — it only deletes derived data.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.models import (
    FxHistory,
    Instrument,
    PriceCacheMetadata,
    PriceHistory,
)

log = logging.getLogger(__name__)


def cleanup_orphan_cache_rows(ledger_session: Session, cache_session: Session) -> dict[str, int]:
    """Delete cache rows whose ``instrument_id`` is not on the ledger.

    Returns a dict of ``{table_name: rows_deleted}``. ``FxHistory`` has
    no instrument link and is never touched.
    """
    live_ids = set(ledger_session.execute(select(Instrument.id)).scalars().all())
    deleted: dict[str, int] = {}
    for model in (PriceHistory, PriceCacheMetadata):
        rows = cache_session.execute(select(model)).scalars().all()
        n = 0
        for row in rows:
            if row.instrument_id not in live_ids:
                cache_session.delete(row)
                n += 1
        deleted[model.__tablename__] = n
    # ``FxHistory`` and ``PositionSnapshot`` don't carry an
    # instrument_id; surface their table names so monitoring callers
    # see a stable shape.
    deleted.setdefault(FxHistory.__tablename__, 0)
    if any(deleted.values()):
        cache_session.flush()
        log.info("cache-orphan janitor removed %s", deleted)
    return deleted
