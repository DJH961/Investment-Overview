"""Database reset service — wipe selected data so the user can re-import.

The dashboard accumulates three logical kinds of data:

* **Cached market data** — prices, FX rates, splits, the within-day
  intraday samples (which power the Overview "1 Day"/"1 Week" graphs),
  position snapshots and the price-cache bookkeeping. All of it is derived
  and re-downloaded/recomputed on the next refresh, so clearing it is
  completely safe. The intraday samples in particular must be wiped here:
  a stale or malformed intraday curve is exactly the kind of thing a user
  resets the cache to get rid of, so leaving it behind would make the
  "1 Day"/"1 Week" graphs look broken even after a reset.
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

from investment_dashboard.db import (
    cache_session_scope,
    config_session_scope,
    ledger_session_scope,
)
from investment_dashboard.repositories import maintenance_repo

log = logging.getLogger(__name__)


class ResetLevel(enum.Enum):
    """How much data a reset removes (smallest blast radius first)."""

    #: Prices, FX rates and snapshots — derived, rebuilt on next refresh.
    CACHE = "cache"
    #: The transaction ledger plus the cached data derived from it.
    TRANSACTIONS = "transactions"
    #: Factory reset: every table, back to first-run state.
    EVERYTHING = "everything"


def _models_for_level(level: ResetLevel) -> tuple[type, ...]:
    if level is ResetLevel.CACHE:
        return maintenance_repo.CACHE_MODELS
    if level is ResetLevel.TRANSACTIONS:
        # Clearing transactions invalidates derived snapshots/prices, so wipe
        # the cache too. FK-safe order: snapshots/cache first, then transactions.
        return maintenance_repo.TRANSACTION_MODELS
    return maintenance_repo.ALL_MODELS_FK_SAFE_ORDER


@dataclass(frozen=True)
class ResetResult:
    """Outcome of a :func:`reset_database` call."""

    level: ResetLevel
    #: Per-table row counts removed, keyed by ``__tablename__``.
    deleted: dict[str, int] = field(default_factory=dict)

    @property
    def total_deleted(self) -> int:
        return sum(self.deleted.values())


def reset_database(level: ResetLevel) -> ResetResult:
    """Delete the data covered by ``level`` and return per-table counts.

    Models are grouped by storage tier so the deletes run inside the correct
    transactional session. In a split-DB deployment each tier lives on its own
    SQLite file (config overrides in one engine, the regenerable cache —
    prices/FX/snapshots/intraday samples — in another, the ledger in a third),
    so a delete issued on the wrong tier's session targets a file that does not
    even contain that table and silently leaves the cached rows in place. That
    is exactly how a "Reset cached market data" could appear to do nothing while
    the 1 Day / 1 Week graphs kept their stale samples. Each tier therefore runs
    through its own ``*_session_scope`` and commits atomically when its ``with``
    block exits.
    """
    models = _models_for_level(level)
    ledger_models, cache_models, config_models = maintenance_repo.split_by_tier(models)

    log.info(
        "database reset (%s): wiping %s table(s): %s",
        level.value,
        len(models),
        ", ".join(maintenance_repo.table_name(m) for m in models),
    )

    deleted: dict[str, int] = {}

    if ledger_models:
        with ledger_session_scope() as session:
            for model in ledger_models:
                deleted[maintenance_repo.table_name(model)] = maintenance_repo.delete_all(
                    session, model
                )

    if cache_models:
        with cache_session_scope() as session:
            for model in cache_models:
                deleted[maintenance_repo.table_name(model)] = maintenance_repo.delete_all(
                    session, model
                )

    if config_models:
        with config_session_scope() as session:
            for model in config_models:
                deleted[maintenance_repo.table_name(model)] = maintenance_repo.delete_all(
                    session, model
                )

    result = ResetResult(level=level, deleted=deleted)
    log.info(
        "database reset (%s): removed %s row(s) across %s table(s) (%s)",
        level.value,
        result.total_deleted,
        len(deleted),
        ", ".join(f"{name}={count}" for name, count in deleted.items()),
    )
    return result
