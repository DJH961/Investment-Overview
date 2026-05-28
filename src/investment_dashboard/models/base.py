"""Declarative bases — partitioned by storage tier.

Money is stored as ``Numeric(18, 6)``; share quantities as ``Numeric(18, 8)``;
FX rates as ``Numeric(12, 8)``. SQLAlchemy returns ``decimal.Decimal`` from
``Numeric`` columns, avoiding float drift on financial math.

The schema is split across three tiers, each owning a separate
``MetaData`` so that a later phase can mount each on its own SQLite file
without touching the ORM definitions again:

* :class:`LedgerBase` — facts that *happened* (the immutable source of
  truth: accounts, instruments, transactions). Encrypted and synced
  across devices in production.
* :class:`ConfigBase` — preferences and choices (display settings,
  target allocations, per-instrument/account override fields, the
  secondary-device write queue). Encrypted and synced.
* :class:`CacheBase` — derived/regenerable data (prices, FX rates,
  position snapshots, refresh metadata). Strictly device-local; never
  encrypted, never synced.

Until the engine split lands (Phase 2 in the rework), all three
metadatas are still created on the same SQLite file. The legacy
``Base`` alias is kept so external imports keep working; new code
should use the tier-specific bases.
"""

from __future__ import annotations

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase


class LedgerBase(DeclarativeBase):
    """Source-of-truth tables: accounts, instruments, transactions."""

    metadata = MetaData()


class ConfigBase(DeclarativeBase):
    """User-choice tables: app_config, allocations, overrides, queue."""

    metadata = MetaData()


class CacheBase(DeclarativeBase):
    """Device-local regenerable tables: prices, FX, snapshots."""

    metadata = MetaData()


#: Iterable of every tier's ``MetaData``. Use this in tests and in
#: ``boot`` to run ``create_all`` / ``drop_all`` across every tier in one
#: place, so adding a new tier later is a single-line change.
ALL_METADATAS = (LedgerBase.metadata, ConfigBase.metadata, CacheBase.metadata)


# Backwards-compatible alias. Existing code that imports ``Base`` keeps
# compiling; ``Base.metadata`` now points at the ledger metadata only,
# which matches the historically dominant use (most tables that lived on
# ``Base`` were ledger tables). New code MUST use the tier-specific
# bases explicitly so the partition stays honest.
Base = LedgerBase
