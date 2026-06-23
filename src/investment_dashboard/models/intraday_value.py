"""Intraday market-component samples — powers the Overview "1 Day" graph.

Stores one row per captured instant (UTC) with the EUR value of only the
**intraday-priced** holdings (stocks/ETFs) at that moment — deliberately *not*
the whole-portfolio total. The constant cash + NAV base (mutual funds and
money-market funds, which print at most one NAV a day) is added back at render
time, so those holdings never enter the curve's intraday variation. This keeps
live-captured and reconstructed points on a single consistent basis: a holding
whose NAV is revalued after the close (e.g. a mutual fund) shifts the whole
curve uniformly via the base instead of spiking it at the points captured before
the revaluation. See
:mod:`investment_dashboard.services.intraday_snapshots_service`.

Unlike :class:`PositionSnapshot` (one row per *calendar date*, used by the
longer-range curves), this table keeps the *within-day* shape of the portfolio
so the "Day" range renders a real intraday line — every market-hours price
refresh appends a point, so the more often the app auto-updates prices, the
denser the curve.

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
    """One row per captured instant — the intraday-priced holdings' EUR value.

    ``captured_at`` is a naive UTC timestamp (mirroring
    :attr:`PositionSnapshot.computed_at`); display-timezone formatting happens
    in the UI layer, never in storage. ``market_value_eur`` is the EUR value of
    the *intraday-priced* holdings only (stocks/ETFs) — the constant cash + NAV
    base is reapplied at render time (see the module docstring).
    """

    __tablename__ = "intraday_value"

    captured_at: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    market_value_eur: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<IntradayValue {self.captured_at:%Y-%m-%d %H:%M} = €{self.market_value_eur}>"
