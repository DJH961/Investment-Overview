"""ORM models. Imported eagerly via this module's ``__init__`` so Alembic and
``Base.metadata.create_all`` see every table without manual registration.

Each model belongs to one of three storage tiers (ledger / config /
cache); see :mod:`investment_dashboard.models.base`. The ``ALL_METADATAS``
tuple is the canonical way to enumerate every tier's ``MetaData`` for
``create_all`` / ``drop_all``.
"""

from __future__ import annotations

from investment_dashboard.models.account import Account
from investment_dashboard.models.app_config import AppConfig
from investment_dashboard.models.base import (
    ALL_METADATAS,
    Base,
    CacheBase,
    ConfigBase,
    LedgerBase,
)
from investment_dashboard.models.fx_history import FxHistory
from investment_dashboard.models.instrument import Instrument
from investment_dashboard.models.instrument_override import InstrumentOverride
from investment_dashboard.models.position_snapshot import PositionSnapshot
from investment_dashboard.models.price_cache_metadata import PriceCacheMetadata
from investment_dashboard.models.price_history import PriceHistory
from investment_dashboard.models.price_split import PriceSplit
from investment_dashboard.models.target_allocation import (
    TargetAllocation,
    TargetAllocationItem,
)
from investment_dashboard.models.transaction import Transaction, TransactionKind

__all__ = [
    "ALL_METADATAS",
    "Account",
    "AppConfig",
    "Base",
    "CacheBase",
    "ConfigBase",
    "FxHistory",
    "Instrument",
    "InstrumentOverride",
    "LedgerBase",
    "PositionSnapshot",
    "PriceCacheMetadata",
    "PriceHistory",
    "PriceSplit",
    "TargetAllocation",
    "TargetAllocationItem",
    "Transaction",
    "TransactionKind",
]
