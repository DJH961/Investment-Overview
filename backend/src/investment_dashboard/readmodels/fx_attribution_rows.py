"""Daily input rows for :mod:`domain.fx_attribution` (Currency page, 7.2).

For a date range and a reporting currency (EUR or USD) this builds one
:class:`~investment_dashboard.domain.fx_attribution.AttributionDay` per close:

- **Book per native currency** = the per-holding daily values (7.1's
  ``services.holding_values_service``, read through the
  :class:`HoldingValuesSource` protocol) summed per currency, plus the cash and
  savings account balances (the same scope :func:`metrics_service.book_holdings`
  and the Overview total use; idle broker cash is not part of the book there
  either). Native values only.
- **Rates**: the *settled* daily ECB/Frankfurter rates from ``fx_service``,
  forward-filled. Today's live intraday overlay is never used: a past day is
  always valued at its own fixing, and today at the settled fixing when there is
  one.
- **Flows**: the cashflow-legs path (:func:`services.cashflows.build_portfolio_cashflows`),
  i.e. ``net_native`` at that date's rate plus the FX-pool conversion overrides,
  never the frozen ``net_eur`` / ``net_usd`` legs. The stream's sign is flipped
  (money into the book is positive). Note: for a matched deposit the override
  makes the euro flow the deposit's effective euro cost, not ``dollars / r_t``;
  that conversion-cost difference therefore stays inside the *flow* part (and so
  outside both market and currency) until push 7.3 shows it on its own.

**Broker cash (opt-in, ``include_broker_cash``; the Impact section).** The book
then also holds each brokerage account's idle cash: the running sum of the
account's own ``net_native`` (the same "uninvested cash" as
:func:`positions_service.compute_cash_balance`), except that a reinvested dividend
(its ``dividend_reinvest`` row and its paired ``dividend_cash`` leg) never touches
cash: its shares are in the holdings already. Deposits and withdrawals are then
the only external flows (dividends and interest stay in the book). A balance that
would go below zero at a day's end (a deposit missing from the ledger: an in-kind
transfer, a bank transfer straight into a buy) is held at zero and the shortfall is
booked as an implied deposit that day (:class:`Shortfall`), so the missing money
can never show up as a fake gain or loss.

Rows: an anchor at ``start`` (the book at that close, possibly empty), then
every later date in ``(start, end]`` on which a holding value, a cash
balance change or (when a foreign currency is held) a rate fixing is on file. A flow dated between two rows is booked on the next row (it
happened before that close); a flow after the last row is not in the range.
"""

from __future__ import annotations

import bisect
from collections import defaultdict
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Protocol

from sqlalchemy.orm import Session

from investment_dashboard.domain import dividends as dividends_domain
from investment_dashboard.domain.fx_attribution import AttributionDay, FxRate
from investment_dashboard.domain.kinds import DIVIDEND_CASH, DIVIDEND_REINVEST
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.repositories import accounts_repo, transactions_repo
from investment_dashboard.services import (
    cashflows,
    fx_service,
    holding_values_service,
    metrics_service,
)
from investment_dashboard.services.holding_values_service import (
    HoldingDayDividend,
    HoldingDayValue,
)

ZERO = Decimal(0)
#: How far before a range start the holding values are read (a close to carry in).
_LOOKBACK = timedelta(days=10)
_CASH_ACCOUNT_TYPES = frozenset({"savings", "cash"})
REPORTING_CURRENCIES = ("EUR", "USD")


class HoldingValuesSource(Protocol):
    """What 7.2 needs from 7.1's ``services.holding_values_service`` (contract P16).

    The service module itself satisfies this protocol (:data:`REAL_SOURCE`, the
    default); tests pass a fake. Stored rows run through yesterday; a range that
    reaches today gets today's rows valued live (never stored).
    """

    def holding_values(
        self,
        session: Session,
        start: date,
        end: date,
        instrument_ids: Collection[int] | None = None,
    ) -> Sequence[HoldingDayValue]: ...

    def holding_dividends(
        self,
        session: Session,
        start: date,
        end: date,
        instrument_ids: Collection[int] | None = None,
    ) -> Sequence[HoldingDayDividend]: ...


#: The real 7.1 service (``services.holding_values_service``).
REAL_SOURCE: HoldingValuesSource = holding_values_service


class _Series:
    """A forward-filled ``{date: rate}`` lookup."""

    def __init__(self, rates: Mapping[date, Decimal]) -> None:
        items = sorted((d, r) for d, r in rates.items() if r > 0)
        self._dates = [d for d, _ in items]
        self._rates = [r for _, r in items]

    @property
    def dates(self) -> list[date]:
        return self._dates

    def at(self, on: date) -> Decimal | None:
        i = bisect.bisect_right(self._dates, on)
        return self._rates[i - 1] if i else None


def settled_rates(session: Session, quote: str) -> dict[date, Decimal]:
    """The stored EUR->``quote`` series with no live overlay for today."""
    rates = dict(fx_service.get_rates(session, base="EUR", quote=quote))
    today = exchange_today()
    rates.pop(today, None)
    settled_today = fx_service.get_settled_rate_on(session, today, base="EUR", quote=quote)
    if settled_today is not None:
        rates[today] = settled_today
    return rates


def _fx_rate(ccy: str, reporting: str, on: date, series: Mapping[str, _Series]) -> FxRate | None:
    """``ccy`` -> ``reporting`` on ``on`` from the EUR-based series (None if unknown)."""
    usd = series["USD"].at(on)
    if reporting == "EUR":
        if ccy == "USD":
            return FxRate(divide_by=usd) if usd is not None else None
        q = series[ccy].at(on)
        return FxRate(divide_by=q) if q is not None else None
    # reporting == "USD"
    if usd is None:
        return None
    if ccy == "EUR":
        return FxRate(multiply_by=usd)
    q = series[ccy].at(on)
    return FxRate(divide_by=q, multiply_by=usd) if q is not None else None


def _cash_books(
    session: Session, start: date, end: date
) -> tuple[list[tuple[str, _Steps]], set[date]]:
    """Running balance of each cash/savings account (with its currency) and change dates.

    Same sum as :func:`positions_service.compute_cash_balance` (every
    ``net_native`` up to the date), done in one pass per account.
    """
    accounts: list[tuple[str, _Steps]] = []
    dates: set[date] = set()
    for account in accounts_repo.list_accounts(session):
        if account.account_type not in _CASH_ACCOUNT_TYPES:
            continue
        running = ZERO
        points: dict[date, Decimal] = {}
        for t in transactions_repo.list_transactions(session, account_id=account.id, end=end):
            running += t.net_native or ZERO
            points[t.date] = running
            if start < t.date <= end:
                dates.add(t.date)
        if points:
            accounts.append((account.native_currency.upper(), _Steps(points)))
    return accounts, dates


@dataclass(frozen=True)
class Shortfall:
    """A day a brokerage account's cash would have gone below zero (native)."""

    on: date
    currency: str
    native: Decimal


@dataclass(frozen=True)
class BookRows:
    """Attribution rows plus the implied deposits behind them (broker cash book)."""

    rows: list[AttributionDay]
    shortfalls: list[Shortfall]


def _broker_cash_books(
    session: Session, start: date, end: date
) -> tuple[list[tuple[str, _Steps]], set[date], list[Shortfall]]:
    """Idle cash per non-cash account, clamped at zero (see the module doc)."""
    accounts: list[tuple[str, _Steps]] = []
    dates: set[date] = set()
    shortfalls: list[Shortfall] = []
    txns = list(transactions_repo.list_transactions(session, end=end))
    reinvested = dividends_domain.reinvest_keys(txns)
    by_account: dict[int, list[Any]] = defaultdict(list)
    for t in txns:
        if t.account_id is not None:
            by_account[t.account_id].append(t)
    for account in accounts_repo.list_accounts(session):
        if account.account_type in _CASH_ACCOUNT_TYPES:
            continue
        ccy = account.native_currency.upper()
        day_net: dict[date, Decimal] = defaultdict(lambda: ZERO)
        for t in by_account.get(account.id, []):
            if t.kind == DIVIDEND_REINVEST or (
                t.kind == DIVIDEND_CASH and (t.account_id, t.instrument_id, t.date) in reinvested
            ):
                continue
            day_net[t.date] += t.net_native or ZERO
        running = ZERO
        points: dict[date, Decimal] = {}
        for on in sorted(day_net):
            running += day_net[on]
            if running < 0:
                shortfalls.append(Shortfall(on, ccy, -running))
                running = ZERO
            points[on] = running
            if start < on <= end:
                dates.add(on)
        if points:
            accounts.append((ccy, _Steps(points)))
    return accounts, dates, shortfalls


class _Steps:
    """A step function ``date -> value`` (the last value on or before a date, else 0)."""

    def __init__(self, points: Mapping[date, Decimal]) -> None:
        items = sorted(points.items())
        self._dates = [d for d, _ in items]
        self._values = [v for _, v in items]

    def at(self, on: date) -> Decimal:
        i = bisect.bisect_right(self._dates, on)
        return self._values[i - 1] if i else ZERO


def _flows_by_row(
    session: Session,
    reporting: str,
    row_dates: Sequence[date],
    end: date,
    *,
    retain_all: bool = False,
) -> dict[date, Decimal]:
    """External flows into the book in ``reporting``, booked on the row they precede.

    ``retain_all``: every account's cash is in the book (broker cash), so no
    dividend or interest leaves it.
    """
    txns = transactions_repo.list_transactions(session, end=end)
    retained = (
        {a.id for a in accounts_repo.list_accounts(session)}
        if retain_all
        else metrics_service.build_retained_cash_account_ids(session, txns)
    )
    stream = cashflows.build_portfolio_cashflows(
        txns,
        currency=reporting,
        retained_cash_account_ids=retained,
        eur_to_usd=settled_rates(session, "USD"),
        eur_overrides=cashflows.eur_overrides_for(session),
    )
    out: dict[date, Decimal] = defaultdict(lambda: ZERO)
    if not row_dates:
        return out
    anchor = row_dates[0]
    for cf in stream:
        if cf.date <= anchor:
            continue
        i = bisect.bisect_left(row_dates, cf.date)
        if i >= len(row_dates):
            continue
        out[row_dates[i]] -= cf.amount  # XIRR sign: money in is negative
    return out


def _day_rates(
    book: Mapping[str, Decimal],
    foreign: Sequence[str],
    rep: str,
    on: date,
    series: Mapping[str, _Series],
) -> dict[str, FxRate]:
    """Each foreign currency's rate on ``on``; a held currency without one is an error."""
    rates: dict[str, FxRate] = {}
    for ccy in foreign:
        rate = _fx_rate(ccy, rep, on, series)
        if rate is not None:
            rates[ccy] = rate
        elif book.get(ccy):
            raise ValueError(f"no {ccy} rate on file for {on.isoformat()}")
    return rates


def build_attribution_rows(
    session: Session,
    start: date,
    end: date,
    reporting: str,
    *,
    source: HoldingValuesSource = REAL_SOURCE,
) -> list[AttributionDay]:
    """The daily rows for ``[start, end]`` in ``reporting`` (``EUR`` or ``USD``).

    Raises ``ValueError`` when a currency held in the range has no rate on file
    for a row (an honest gap, never a rate of 1).
    """
    return _build_rows(session, start, end, reporting, source=source).rows


def build_book_rows(
    session: Session,
    start: date,
    end: date,
    reporting: str,
    *,
    source: HoldingValuesSource = REAL_SOURCE,
) -> BookRows:
    """:func:`build_attribution_rows` with each brokerage account's idle cash in the
    book and its implied deposits (see the module doc). The Impact section only."""
    return _build_rows(session, start, end, reporting, source=source, broker_cash=True)


def _build_rows(  # noqa: PLR0912
    session: Session,
    start: date,
    end: date,
    reporting: str,
    *,
    source: HoldingValuesSource,
    broker_cash: bool = False,
) -> BookRows:
    rep = reporting.upper()
    if rep not in REPORTING_CURRENCIES:
        raise ValueError(f"reporting currency must be one of {REPORTING_CURRENCIES}")
    if end < start:
        raise ValueError("end must not be before start")

    # Each holding's value is a step function: the real service stores rows on
    # trading days (plus trade / dividend days), so on a US holiday with an ECB
    # fixing (a row date) the holding still holds its last close; a full sale
    # leaves a quantity-0 row, so the step drops to zero there. The read starts a
    # little before ``start`` so the anchor sees the last close before it.
    points: dict[tuple[int, int, str], dict[date, Decimal]] = defaultdict(dict)
    for hv in source.holding_values(session, start - _LOOKBACK, end):
        if hv.date <= end:
            points[(hv.instrument_id, hv.account_id, hv.currency.upper())][hv.date] = (
                hv.value_native
            )
    holding_steps = [(key[2], _Steps(p)) for key, p in points.items()]
    holding_dates = {d for p in points.values() for d in p if start < d <= end}
    cash_steps, cash_dates = _cash_books(session, start, end)
    shortfalls: list[Shortfall] = []
    if broker_cash:
        broker_steps, broker_dates, shortfalls = _broker_cash_books(session, start, end)
        cash_steps += broker_steps
        cash_dates |= broker_dates

    currencies: set[str] = {ccy for ccy, _ in cash_steps} | {ccy for ccy, _ in holding_steps}
    foreign = sorted(c for c in currencies if c != rep)
    series = {
        q: _Series(settled_rates(session, q)) for q in {"USD", *(c for c in foreign if c != "EUR")}
    }
    # A fixing day is a row too (when a foreign currency is held), so a book that
    # did not change (cash only) is still revalued on the day its rate moved.
    fx_dates = (
        {d for s in series.values() for d in s.dates if start < d <= end} if foreign else set()
    )
    row_dates = sorted({start} | holding_dates | cash_dates | fx_dates)
    flows = _flows_by_row(session, rep, row_dates, end, retain_all=broker_cash)

    day_books: list[dict[str, Decimal]] = []
    day_rates: list[dict[str, FxRate]] = []
    for on in row_dates:
        book: dict[str, Decimal] = {}
        for ccy, steps in holding_steps:
            value = steps.at(on)
            if value:
                book[ccy] = book.get(ccy, ZERO) + value
        for ccy, steps in cash_steps:
            bal = steps.at(on)
            if bal:
                book[ccy] = book.get(ccy, ZERO) + bal
        day_books.append(book)
        day_rates.append(_day_rates(book, foreign, rep, on, series))
    # A row dated before a currency's first rate on file (e.g. the empty anchor
    # before the first deposit) does not hold that currency, so its value does not
    # depend on the rate; borrow the next row's rate so the next day's currency
    # part (which revalues *that* day's book from this row's rate) is zero rather
    # than undefined. Money cannot carry a rate move from before rates exist.
    for i in range(len(day_rates) - 2, -1, -1):
        for ccy, rate in day_rates[i + 1].items():
            day_rates[i].setdefault(ccy, rate)
    # Implied deposits (a broker balance held at zero): money in on its own day,
    # at that day's rate, like any deposit.
    for sf in shortfalls:
        if not start < sf.on <= end:
            continue
        sf_rate: FxRate | None = (
            FxRate() if sf.currency == rep else _fx_rate(sf.currency, rep, sf.on, series)
        )
        if sf_rate is None:
            raise ValueError(f"no {sf.currency} rate on file for {sf.on.isoformat()}")
        i = bisect.bisect_left(row_dates, sf.on)
        flows[row_dates[i]] = flows.get(row_dates[i], ZERO) + sf_rate.to_reporting(sf.native)
    rows = [
        AttributionDay(on=on, book=b, rates=r, flow=flows.get(on, ZERO))
        for on, b, r in zip(row_dates, day_books, day_rates, strict=True)
    ]
    return BookRows(rows, [sf for sf in shortfalls if start < sf.on <= end])


class RateBook:
    """The settled, forward-filled daily rates of some currencies into ``reporting``.

    The same rates :func:`build_attribution_rows` values its rows at, for readers
    that need a single holding's rate per day (the per-holding split).
    """

    def __init__(self, session: Session, reporting: str, currencies: Iterable[str]) -> None:
        self.reporting = reporting.upper()
        wanted = {c.upper() for c in currencies} - {self.reporting}
        self._series = {
            q: _Series(settled_rates(session, q))
            for q in {"USD", *(c for c in wanted if c != "EUR")}
        }
        self.foreign = sorted(wanted)

    def rate(self, ccy: str, on: date) -> FxRate | None:
        """``ccy`` -> reporting on ``on`` (identity for the reporting currency)."""
        code = ccy.upper()
        if code == self.reporting:
            return FxRate()
        if code != "EUR" and code not in self._series:
            return None
        return _fx_rate(code, self.reporting, on, self._series)

    def fixing_dates(self, start: date, end: date) -> set[date]:
        """Dates in ``(start, end]`` with a fixing on file for any held foreign currency."""
        if not self.foreign:
            return set()
        return {d for s in self._series.values() for d in s.dates if start < d <= end}


def monthly_contributions(rows: Iterable[AttributionDay]) -> list[Decimal]:
    """Net flows per calendar month of ``rows`` (anchor excluded), for the months input."""
    it = iter(rows)
    next(it, None)
    months: dict[str, Decimal] = {}
    for r in it:
        key = f"{r.on.year:04d}-{r.on.month:02d}"
        months[key] = months.get(key, ZERO) + r.flow
    return list(months.values())
