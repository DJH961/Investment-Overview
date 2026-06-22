"""Intraday portfolio-value samples — powers the Overview "1 Day" graph.

Stores one row per captured instant (UTC) with the whole-portfolio EUR
mark-to-market at that moment. Unlike :class:`PositionSnapshot` (one row per
*calendar date*, used by the longer-range curves), this table keeps the
*within-day* shape of the portfolio so the "Day" range renders a real intraday
line — every market-hours price refresh appends a point, so the more often the
app auto-updates prices, the denser the curve.

Belongs to the **cache** tier (device-local, regenerable): only today's session
is retained (older rows are pruned as fresh ones land), and the data is rebuilt
naturally as the app keeps running. Read/write it only through
:mod:`investment_dashboard.services.intraday_snapshots_service`.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Numeric
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import CacheBase as Base


class IntradayValue(Base):
    """One row per captured instant — the total portfolio value in EUR.

    ``captured_at`` is a naive UTC timestamp (mirroring
    :attr:`PositionSnapshot.computed_at`); display-timezone formatting happens
    in the UI layer, never in storage.
    """

    __tablename__ = "intraday_value"

    captured_at: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    total_value_eur: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<IntradayValue {self.captured_at:%Y-%m-%d %H:%M} = €{self.total_value_eur}>"
