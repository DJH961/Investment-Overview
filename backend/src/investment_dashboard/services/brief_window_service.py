"""The Daily Brief's window move: how the book did over the owner's whole absence.

Everything the Brief needs besides the hero's own end value (which the readmodel takes
from the Overview payload): the book at the window's start, the money put in meanwhile
and each holding's start and end price. Per reporting currency, never converted: the
dollar view works on native dollars, the euro view revalues dollars at the rate of each
instant (see :mod:`investment_dashboard.domain.brief`).

Start of the window, ``start_at`` (``visit_from``):

* ``intraday``: a stored intraday sample lies at most 30 minutes before ``start_at``;
  the book is that sample (the intraday-priced holdings at that instant's prices and
  rate) plus the cash and NAV holdings at the last official close;
* ``close``: otherwise, the book at the last official close at or before ``start_at``,
  valued at that day's settled rate.

Flows are the external money legs of portfolio XIRR dated after that close and up to
today (:func:`metrics_service.session_external_flows`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy.orm import Session

from investment_dashboard.domain import brief as brief_domain
from investment_dashboard.domain import market_hours
from investment_dashboard.domain.late_data import value_at_rate
from investment_dashboard.services import (
    fx_service,
    intraday_snapshots_service,
    metrics_service,
    positions_service,
)

ZERO = Decimal(0)
_MAX_BACK_DAYS = 14
TOP = 3


@dataclass(frozen=True)
class HoldingLeg:
    """One holding at the window's start and now (native prices)."""

    symbol: str
    name: str
    native_currency: str
    shares: Decimal
    price_start: Decimal
    price_end: Decimal


@dataclass(frozen=True)
class WindowInputs:
    """The window's start side, per currency, plus what the movers need."""

    start_at: datetime
    end_at: datetime
    start_basis: Literal["intraday", "close"]
    #: Last official close date at or before ``start_at`` (the start book's date).
    start_date: date
    start_eur: Decimal
    start_usd: Decimal
    flows_eur: Decimal
    flows_usd: Decimal
    #: The rate at ``start_at`` (the sample's, or that day's settled one).
    rate_then: Decimal
    #: The start book as native holdings (the currency effect revalues it).
    book: list[Any]
    legs: list[HoldingLeg]


def _utc(moment: datetime) -> datetime:
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def start_close_date(start_at: datetime) -> date | None:
    """The last NYSE trading day whose close is at or before ``start_at``."""
    start_at = _utc(start_at)
    day = market_hours.exchange_today(start_at)
    for _ in range(_MAX_BACK_DAYS):
        if (
            market_hours.is_trading_day(day)
            and market_hours.regular_session_close(day).astimezone(UTC) <= start_at
        ):
            return day
        day -= timedelta(days=1)
    return None


def _legs(session: Session, start_date: date, end_date: date) -> list[HoldingLeg]:
    """Holdings at the start close with their start and current native prices."""
    end_prices: dict[int, Decimal] = {}
    for p in positions_service.compute_positions(session, as_of=end_date):
        if p.current_price_native is not None and p.current_price_native > 0:
            end_prices.setdefault(p.instrument.id, p.current_price_native)
    by_instrument: dict[int, HoldingLeg] = {}
    for p in positions_service.compute_positions(session, as_of=start_date):
        price = p.current_price_native
        end = end_prices.get(p.instrument.id)
        if price is None or price <= 0 or end is None or p.shares <= 0:
            continue
        held = by_instrument.get(p.instrument.id)
        shares = p.shares + (held.shares if held is not None else ZERO)
        by_instrument[p.instrument.id] = HoldingLeg(
            symbol=p.instrument.symbol,
            name=(p.effective.name if p.effective is not None else p.instrument.name)
            or p.instrument.symbol,
            native_currency=p.account.native_currency,
            shares=shares,
            price_start=price,
            price_end=end,
        )
    return list(by_instrument.values())


def collect(session: Session, *, start_at: datetime, now: datetime) -> WindowInputs | None:
    """The window's start side, or ``None`` when no start value can be built."""
    start_at, now = _utc(start_at), _utc(now)
    start_date = start_close_date(start_at)
    if start_date is None or now <= start_at:
        return None
    end_date = market_hours.exchange_today(now)
    book = metrics_service.book_holdings(session, start_date)
    if not book:
        return None
    sample = intraday_snapshots_service.sample_at(session, start_at)
    basis: Literal["intraday", "close"] = "close"
    if sample is not None and sample.market_usd is not None:
        positions = positions_service.compute_positions(session, as_of=start_date)
        base = metrics_service.book_holdings(
            session,
            start_date,
            positions=[
                p for p in positions if not intraday_snapshots_service.is_intraday_priced(p)
            ],
        )
        base_eur, base_usd = value_at_rate(base, sample.fx_eur_usd)
        start_eur = sample.market_eur + base_eur
        start_usd = sample.market_usd + base_usd
        rate_then = sample.fx_eur_usd
        basis = "intraday"
    else:
        settled = fx_service.get_settled_rate(session, start_date)
        if settled is None or settled <= 0:
            return None
        start_eur, start_usd = value_at_rate(book, settled)
        rate_then = settled
    flows_eur = flows_usd = ZERO
    if end_date > start_date:
        flows_eur, flows_usd = metrics_service.session_external_flows(
            session, start_date, end_date, eur_to_usd=fx_service.get_rates(session)
        )
    return WindowInputs(
        start_at=start_at,
        end_at=now,
        start_basis=basis,
        start_date=start_date,
        start_eur=start_eur,
        start_usd=start_usd,
        flows_eur=flows_eur,
        flows_usd=flows_usd,
        rate_then=rate_then,
        book=book,
        legs=_legs(session, start_date, max(end_date, start_date)),
    )


@dataclass(frozen=True)
class MoverRow:
    symbol: str
    name: str
    move: Decimal
    pct: Decimal


def movers(
    legs: list[HoldingLeg],
    *,
    view: Literal["EUR", "USD"],
    rate_then: Decimal | None,
    rate_now: Decimal | None,
) -> tuple[int, list[MoverRow], list[MoverRow]]:
    """``(eligible, winners, losers)``: the top three up and down by percentage."""
    rows: list[MoverRow] = []
    for leg in legs:
        figure = brief_domain.holding_window_move(
            view=view,
            native_currency=leg.native_currency,
            shares=leg.shares,
            price_start=leg.price_start,
            price_end=leg.price_end,
            rate_then=rate_then,
            rate_now=rate_now,
        )
        if figure is not None:
            rows.append(MoverRow(leg.symbol, leg.name, figure[0], figure[1]))
    winners = sorted((r for r in rows if r.pct > 0), key=lambda r: r.pct, reverse=True)[:TOP]
    losers = sorted((r for r in rows if r.pct < 0), key=lambda r: r.pct)[:TOP]
    return len(rows), winners, losers
