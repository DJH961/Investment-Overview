"""Per-instrument market-data refresh metadata.

Belongs to the **cache** tier. ``instrument_id`` references the
ledger-tier ``instruments`` table by integer only (no SQLAlchemy
``ForeignKey``); see :mod:`price_history` for the rationale.

Stores ``last_refreshed_at`` per instrument so the background price loop
can decide whether a symbol is due for a refresh based on its
``asset_class`` TTL (etf/stock = near-live, mutual_fund = ~daily,
cash/savings = opt-out).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import CacheBase as Base


class PriceCacheMetadata(Base):
    """Last time the price cache for ``instrument_id`` was refreshed."""

    __tablename__ = "price_cache_metadata"

    instrument_id: Mapped[int] = mapped_column(primary_key=True)
    last_refreshed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    #: When the served price was last struck on the exchange (yfinance's
    #: ``regularMarketTime``) — *when the price is from*, distinct from
    #: ``last_refreshed_at`` (*when we pulled it*). Nullable: the provider does
    #: not always publish it, and money-market / never-fetched rows have none.
    price_market_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<PriceCacheMetadata instr={self.instrument_id} at={self.last_refreshed_at}>"
