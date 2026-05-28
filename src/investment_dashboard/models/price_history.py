"""Daily closing prices per instrument, in the instrument's native currency.

Belongs to the **cache** tier (device-local, regenerable from market data
+ ``Instrument`` rows). ``instrument_id`` references the ledger-tier
``instruments`` table by integer only — SQLAlchemy cannot bridge a
``ForeignKey`` across separate ``MetaData`` instances, and Phase 2 of the
DB split puts each tier on its own SQLite file where DB-level FKs would
not be enforced anyway. Referential integrity is maintained at the
application level (writers check the instrument exists; a boot-time
cache-orphan janitor sweeps rows whose instrument was deleted).
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import CacheBase as Base


class PriceHistory(Base):
    __tablename__ = "price_history"

    instrument_id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[date] = mapped_column(Date, primary_key=True)
    close_native: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="yfinance")
