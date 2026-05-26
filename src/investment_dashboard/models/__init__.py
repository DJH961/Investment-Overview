"""ORM models. Imported eagerly via this module's ``__init__`` so Alembic and
``Base.metadata.create_all`` see every table without manual registration.
"""

from __future__ import annotations

from investment_dashboard.models.account import Account
from investment_dashboard.models.app_config import AppConfig
from investment_dashboard.models.base import Base
from investment_dashboard.models.fx_history import FxHistory
from investment_dashboard.models.instrument import Instrument
from investment_dashboard.models.price_history import PriceHistory
from investment_dashboard.models.target_allocation import (
    TargetAllocation,
    TargetAllocationItem,
)
from investment_dashboard.models.transaction import Transaction, TransactionKind

__all__ = [
    "Account",
    "AppConfig",
    "Base",
    "FxHistory",
    "Instrument",
    "PriceHistory",
    "TargetAllocation",
    "TargetAllocationItem",
    "Transaction",
    "TransactionKind",
]
