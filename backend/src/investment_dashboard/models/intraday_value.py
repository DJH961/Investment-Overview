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
    the *intraday-priced* holdings only (stocks/ETFs) at that instant's **own**
    EUR/USD rate — the constant cash + NAV base is reapplied at render time (see
    the module docstring).

    ``fx_eur_usd`` records the EUR→USD spot (USD per 1 EUR) in force at that very
    instant, so the curve can be re-expressed in either currency at the *true
    per-timestamp* rate rather than a single uniform conversion. USD is the booked
    currency, so the USD line is **FX-free** (price only) — the native value is
    recovered by removing exactly this stored rate from the EUR pivot, never by
    applying FX to USD. The EUR line is the *derived* one: it carries the
    per-minute rate directly, so the two legitimately diverge as the FX market
    moves through the session. ``NULL`` for legacy rows (or when no rate could be
    sourced), in which case the render falls back to today's rate for that point.
    """

    __tablename__ = "intraday_value"

    captured_at: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    market_value_eur: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    fx_eur_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 8), nullable=True)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<IntradayValue {self.captured_at:%Y-%m-%d %H:%M} = €{self.market_value_eur}>"
