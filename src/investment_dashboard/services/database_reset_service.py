"""Database reset service — wipe selected data so the user can re-import.

The dashboard accumulates three logical kinds of data:

* **Cached market data** — prices, FX rates, position snapshots and the
  price-cache bookkeeping. All of it is derived and re-downloaded on the
  next refresh, so clearing it is completely safe.
* **Transactions** — the imported buy/sell/dividend ledger. Clearing it
  lets the user re-import a corrected CSV/XLSX without first deleting rows
  by hand. The cached market data is cleared alongside it because position
  snapshots are derived from the (now-removed) transactions.
* **Everything** — a factory reset that also removes accounts, instruments,
  target allocations, per-instrument overrides and app config, returning
  the app to its first-run / onboarding state.

Each level is exposed through :func:`reset_database`, which deletes rows in
a foreign-key-safe order and reports how many rows each table lost. The UI
(Settings → *Reset data*) asks for explicit confirmation before calling it.
"""

from __future__ import annotations

import enum
import logging
from dataclasses import dataclass, field

from sqlalchemy import delete
from sqlalchemy.orm import Session

from investment_dashboard.db import config_session_scope, ledger_session_scope
from investment_dashboard.models import (
    Account,
    AppConfig,
    FxHistory,
    Instrument,
    InstrumentOverride,
    PositionSnapshot,
    PriceCacheMetadata,
    PriceHistory,
    TargetAllocation,
    TargetAllocationItem,
    Transaction,
)
from investment_dashboard.models.base import ConfigBase

log = logging.getLogger(__name__)


class ResetLevel(enum.Enum):
    """How much data a reset removes (smallest blast radius first)."""

    #: Prices, FX rates and snapshots — derived, rebuilt on next refresh.
    CACHE = "cache"
    #: The transaction ledger plus the cached data derived from it.
    TRANSACTIONS = "transactions"
    #: Factory reset: every table, back to first-run state.
    EVERYTHING = "everything"


# Cached/derived tables, ordered so children are deleted before parents.
# None of these carry foreign keys today, but the order is kept explicit so
# adding one later stays safe.
_CACHE_MODELS: tuple[type, ...] = (
    PositionSnapshot,
    PriceHistory,
    PriceCacheMetadata,
    FxHistory,
)

# Every model, in a foreign-key-safe deletion order (children first):
# transactions reference accounts + instruments; allocation items reference
# allocations; so those parents are deleted last.
_ALL_MODELS_FK_SAFE_ORDER: tuple[type, ...] = (
    PositionSnapshot,
    PriceHistory,
    PriceCacheMetadata,
    FxHistory,
    InstrumentOverride,
    TargetAllocationItem,
    TargetAllocation,
    Transaction,
    Instrument,
    Account,
    AppConfig,
)


def _models_for_level(level: ResetLevel) -> tuple[type, ...]:
    if level is ResetLevel.CACHE:
        return _CACHE_MODELS
    if level is ResetLevel.TRANSACTIONS:
        # Clearing transactions invalidates derived snapshots/prices, so wipe
        # the cache too. FK-safe order: snapshots/cache first, then transactions.
        return (*_CACHE_MODELS, Transaction)
    return _ALL_MODELS_FK_SAFE_ORDER


@dataclass(frozen=True)
class ResetResult:
    """Outcome of a :func:`reset_database` call."""

    level: ResetLevel
    #: Per-table row counts removed, keyed by ``__tablename__``.
    deleted: dict[str, int] = field(default_factory=dict)

    @property
    def total_deleted(self) -> int:
        return sum(self.deleted.values())


def _delete_all(session: Session, model: type) -> int:
    """Delete every row of ``model`` and return the number removed."""
    result = session.execute(delete(model))
    return int(result.rowcount or 0)


def reset_database(level: ResetLevel) -> ResetResult:
    """Delete the data covered by ``level`` and return per-table counts.

    Models are grouped by storage tier so the deletes run inside the correct
    transactional session (config-tier overrides live in their own engine in
    split-DB deployments; everything else is ledger-tier). Each tier commits
    atomically when its ``with`` block exits.
    """
    models = _models_for_level(level)
    config_models = tuple(m for m in models if m.__table__.metadata is ConfigBase.metadata)
    ledger_models = tuple(m for m in models if m not in config_models)

    deleted: dict[str, int] = {}

    if ledger_models:
        with ledger_session_scope() as session:
            for model in ledger_models:
                deleted[model.__tablename__] = _delete_all(session, model)

    if config_models:
        with config_session_scope() as session:
            for model in config_models:
                deleted[model.__tablename__] = _delete_all(session, model)

    result = ResetResult(level=level, deleted=deleted)
    log.info(
        "database reset (%s): removed %s row(s) across %s table(s)",
        level.value,
        result.total_deleted,
        len(deleted),
    )
    return result
