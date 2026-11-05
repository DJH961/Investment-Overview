"""Intraday prices of the ETF "twins" that estimate mutual funds on the 1D graph.

Cache tier (regenerable). One row per (twin symbol, instant): the ETF's native
price at ``captured_at`` (naive UTC). The twin's previous session close is stored
as a row at that session's 16:00 New York close instant, so the 1D estimate
``prev_NAV x twin_now / twin_prev_close`` is rebuilt from these rows at read
time (deterministic, nothing estimated is ever stored). Twins are auxiliary
symbols, never holdings: they never enter totals, holdings or allocations.
Pruned to the rolling 1W window like ``intraday_value``. Read/write only through
:mod:`investment_dashboard.services.intraday_snapshots_service`.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import CacheBase as Base


class IntradayTwinPrice(Base):
    __tablename__ = "intraday_twin_prices"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    price_native: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<IntradayTwinPrice {self.symbol} {self.captured_at:%Y-%m-%d %H:%M} {self.price_native}>"
