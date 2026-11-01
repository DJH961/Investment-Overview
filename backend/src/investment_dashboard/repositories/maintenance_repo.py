"""Maintenance repository: bulk deletes and tier-grouped model sets for resets.

Keeps the ORM model lists and the bulk ``DELETE`` out of the service layer.
"""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from investment_dashboard.models import (
    Account,
    AppConfig,
    FxHistory,
    Instrument,
    InstrumentOverride,
    IntradayValue,
    PositionSnapshot,
    PriceCacheMetadata,
    PriceHistory,
    PriceSplit,
    TargetAllocation,
    TargetAllocationItem,
    Transaction,
)
from investment_dashboard.models.base import CacheBase, ConfigBase

#: Cached/derived tables, children before parents (no FKs today; order kept explicit).
CACHE_MODELS: tuple[type, ...] = (
    IntradayValue,
    PositionSnapshot,
    PriceHistory,
    PriceSplit,
    PriceCacheMetadata,
    FxHistory,
)

#: Cache tables plus the transaction ledger.
TRANSACTION_MODELS: tuple[type, ...] = (*CACHE_MODELS, Transaction)

#: Every model in a foreign-key-safe deletion order (children first).
ALL_MODELS_FK_SAFE_ORDER: tuple[type, ...] = (
    *CACHE_MODELS,
    InstrumentOverride,
    TargetAllocationItem,
    TargetAllocation,
    Transaction,
    Instrument,
    Account,
    AppConfig,
)


def split_by_tier(
    models: tuple[type, ...],
) -> tuple[tuple[type, ...], tuple[type, ...], tuple[type, ...]]:
    """Group ``models`` into ``(ledger, cache, config)`` by their metadata."""
    config = tuple(m for m in models if m.__table__.metadata is ConfigBase.metadata)  # type: ignore[attr-defined]
    cache = tuple(m for m in models if m.__table__.metadata is CacheBase.metadata)  # type: ignore[attr-defined]
    ledger = tuple(m for m in models if m not in config and m not in cache)
    return ledger, cache, config


def table_name(model: type) -> str:
    return str(model.__tablename__)  # type: ignore[attr-defined]


def delete_all(session: Session, model: type) -> int:
    """Delete every row of ``model`` and return the number removed."""
    result = session.execute(delete(model))
    return int(result.rowcount or 0)


def delete_orphan_instrument_rows(cache: Session, live_ids: set[int]) -> dict[str, int]:
    """Delete price rows whose ``instrument_id`` is not in ``live_ids``."""
    deleted: dict[str, int] = {}
    for model in (PriceHistory, PriceCacheMetadata):
        n = 0
        for row in cache.execute(select(model)).scalars().all():
            if row.instrument_id not in live_ids:
                cache.delete(row)
                n += 1
        deleted[model.__tablename__] = n
    deleted.setdefault(FxHistory.__tablename__, 0)
    if any(deleted.values()):
        cache.flush()
    return deleted
