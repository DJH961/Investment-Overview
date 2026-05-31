"""Per-instrument stock-split history, sourced from the market-data feed.

Stores one row per (instrument, date) corporate-action split, with the
``ratio`` expressed as ``shares_after / shares_before`` (``2`` for a 2-for-1
split, ``0.5`` for a 1-for-2 reverse split).

Belongs to the **cache** tier (device-local, regenerable from market data).
``instrument_id`` references the ledger-tier ``instruments`` table by integer
only — like :mod:`price_history` it carries no cross-tier ``ForeignKey`` so it
can live on its own SQLite file under the split-DB layout.

The feed is the *authoritative* split source: a split that happened **after**
the user sold an instrument never appears as a ledger ``split`` transaction
(brokers only record splits for shares you still hold), yet yfinance still
back-adjusts that instrument's whole price history for it. Caching the feed's
splits lets historical valuations scale the share count on the same adjustment
basis as the price for *every* instrument, held or long since sold.

Read/write this table only through ``prices_service`` (which routes to the
cache engine); a raw ``splits_repo`` call on a ledger session returns nothing
under a split-DB layout.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import CacheBase as Base


class PriceSplit(Base):
    __tablename__ = "price_split"

    instrument_id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[date] = mapped_column(Date, primary_key=True)
    #: ``shares_after / shares_before`` for the split on ``date``.
    ratio: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="yfinance")
