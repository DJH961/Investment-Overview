"""Split each day's change in value into flows, market and currency (pure).

The convention is the one the Overview's day move already uses
(:func:`services.metrics_service.day_move_split` /
:func:`~services.metrics_service.fx_revaluation` /
:func:`domain.late_data.value_at_rate`): the **currency part** of day ``t`` is
today's book valued at today's rate minus the *same* book valued at yesterday's
rate,

    C_t = sum over currencies c != reporting of [ N_t(c) at r_t(c) - N_t(c) at r_{t-1}(c) ]

the **flow part** ``F_t`` is the day's net external flow in the reporting
currency (supplied by the caller from the cashflow legs, own-date rate), and the
**market part** is the remainder ``M_t = E_t - E_{t-1} - C_t - F_t`` with
``E_t`` the book at today's rates. The three parts therefore always add up to the
day's change, and any period's figure is the sum of its days.

Generic in currency: nothing here knows EUR or USD. In the EUR view the dollar
holdings carry the effect; in the USD view the euro holdings do. Holdings in the
reporting currency never contribute a currency part.

Exactness: each conversion (``native / divide_by * multiply_by``) runs in a fixed
28-digit context, the same precision :func:`value_at_rate` divides at; every sum
and difference then runs in a 200-digit context, so the identities (parts sum to
the change, days sum to the period, bridge adds up, inside + outside = currency)
hold *exactly*, not just to the last digit. Round only for display.

Money here is a sum of reporting-currency amounts at their own dates, which the
currency rule allows; nothing here is a return, annualised or fed to an XIRR.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from decimal import Context, Decimal, localcontext
from itertools import pairwise

ZERO = Decimal(0)
ONE = Decimal(1)

#: Rolling windows in business days (about 3, 6 and 12 months).
ROLLING_WINDOWS: tuple[int, ...] = (63, 126, 252)

_CONVERT = Context(prec=28)
_EXACT_PREC = 200


@contextmanager
def _exact() -> Iterator[None]:
    """A context wide enough that adding the converted amounts never rounds."""
    with localcontext() as ctx:
        ctx.prec = _EXACT_PREC
        yield


@dataclass(frozen=True)
class FxRate:
    """How one unit of a currency becomes the reporting currency on one day.

    ``reporting = native / divide_by * multiply_by``. With ``r`` = USD per EUR:
    in the EUR view a USD holding is ``FxRate(divide_by=r)`` (``N / r``, exactly
    what :func:`value_at_rate` does); in the USD view a EUR holding is
    ``FxRate(multiply_by=r)`` (``N * r``). A third currency ``X`` with ``q`` =
    X per EUR is ``FxRate(divide_by=q)`` in EUR and
    ``FxRate(divide_by=q, multiply_by=r)`` in USD.
    """

    divide_by: Decimal = ONE
    multiply_by: Decimal = ONE

    def __post_init__(self) -> None:
        if self.divide_by <= 0 or self.multiply_by <= 0:
            raise ValueError("FxRate factors must be positive")

    def to_reporting(self, native: Decimal) -> Decimal:
        """``native`` in the reporting currency at this rate."""
        value = native if self.divide_by == ONE else _CONVERT.divide(native, self.divide_by)
        if self.multiply_by != ONE:
            value = _CONVERT.multiply(value, self.multiply_by)
        return value


@dataclass(frozen=True)
class AttributionDay:
    """One close: the book per native currency, that day's rates and its flow.

    ``book`` maps a currency code to the native value held at the close.
    ``rates`` maps every non-reporting currency to that day's :class:`FxRate`
    (a currency held today needs a rate today *and* on the previous row).
    ``flow`` is the day's net external flow into the book, in the reporting
    currency (money in is positive).
    """

    on: date
    book: Mapping[str, Decimal]
    rates: Mapping[str, FxRate]
    flow: Decimal = ZERO


@dataclass(frozen=True)
class DayParts:
    """The move from the previous row's close (``prev_on``) to ``on``.

    ``start + flow + market + currency == end`` exactly.
    """

    prev_on: date
    on: date
    start: Decimal
    end: Decimal
    flow: Decimal
    market: Decimal
    currency: Decimal


@dataclass(frozen=True)
class CumulativePoint:
    """Running totals since the start of the range, at the close of ``on``.

    ``constant_currency = value - currency``: the actual value minus the
    currency effect accumulated over the range (each rate move counted only for
    the money held when it happened), *not* today's book at the starting rate.
    """

    on: date
    value: Decimal
    flow: Decimal
    market: Decimal
    currency: Decimal
    constant_currency: Decimal


@dataclass(frozen=True)
class Bridge:
    """A period's bridge: ``start + flows + market + currency == end`` exactly.

    ``label`` is ``""`` for an arbitrary range, ``"YYYY-MM"`` for a month and
    ``"YYYY"`` for a year. ``start_on`` is the close the period starts from (the
    previous row), ``end_on`` the last close in it.
    """

    label: str
    start_on: date
    end_on: date
    start: Decimal
    flows: Decimal
    market: Decimal
    currency: Decimal
    end: Decimal


@dataclass(frozen=True)
class Extreme:
    """One record: a day (``label`` = ISO date), month or year and its currency part."""

    label: str
    currency: Decimal


@dataclass(frozen=True)
class Records:
    """Best and worst day, month and year by currency part (``None`` when empty)."""

    best_day: Extreme | None
    worst_day: Extreme | None
    best_month: Extreme | None
    worst_month: Extreme | None
    best_year: Extreme | None
    worst_year: Extreme | None


@dataclass(frozen=True)
class RollingPoint:
    """Currency part summed over the ``window`` business days ending at ``on``."""

    on: date
    window: int
    currency: Decimal


@dataclass(frozen=True)
class Run:
    """The current streak of months whose currency part has one sign.

    ``sign`` is ``1`` (tailwind) or ``-1`` (headwind); ``since`` is the first
    month of the streak (``"YYYY-MM"``); ``currency`` is its summed effect.
    """

    sign: int
    length: int
    since: str
    currency: Decimal


@dataclass(frozen=True)
class SessionLegs:
    """One day's currency part split at the session open (same book).

    ``outside`` = previous close rate -> today's open rate (overnight, weekends
    and holidays); ``inside`` = open -> close. ``outside + inside == currency``
    exactly.
    """

    outside: Decimal
    inside: Decimal
    currency: Decimal


def book_value(book: Mapping[str, Decimal], rates: Mapping[str, FxRate], reporting: str) -> Decimal:
    """The book in the reporting currency at ``rates`` (one instant)."""
    rep = reporting.upper()
    total = ZERO
    with _exact():
        for ccy, native in book.items():
            total += _convert(ccy, native, rates, rep)
    return total


def _convert(ccy: str, native: Decimal, rates: Mapping[str, FxRate], rep: str) -> Decimal:
    code = ccy.upper()
    if code == rep or native == 0:
        return native
    rate = rates.get(code)
    if rate is None:
        rate = rates.get(ccy)
    if rate is None:
        raise ValueError(f"no rate for {code} in reporting currency {rep}")
    return rate.to_reporting(native)


def revaluation(
    book: Mapping[str, Decimal],
    reporting: str,
    *,
    rates_from: Mapping[str, FxRate],
    rates_to: Mapping[str, FxRate],
) -> Decimal:
    """Change in the book's value when only the rates move (``fx_revaluation``)."""
    rep = reporting.upper()
    total = ZERO
    with _exact():
        for ccy, native in book.items():
            if ccy.upper() == rep or native == 0:
                continue
            total += _convert(ccy, native, rates_to, rep) - _convert(ccy, native, rates_from, rep)
    return total


def attribute_days(days: Sequence[AttributionDay], reporting: str) -> list[DayParts]:
    """Daily parts for each row after the first (the first row is the anchor).

    Rows must be in ascending date order. The anchor row's ``flow`` is ignored:
    the range starts from its close.
    """
    parts: list[DayParts] = []
    for prev, cur in pairwise(days):
        if cur.on <= prev.on:
            raise ValueError("attribution rows must be in strictly ascending date order")
        start = book_value(prev.book, prev.rates, reporting)
        end = book_value(cur.book, cur.rates, reporting)
        currency = revaluation(cur.book, reporting, rates_from=prev.rates, rates_to=cur.rates)
        with _exact():
            market = end - start - currency - cur.flow
        parts.append(
            DayParts(
                prev_on=prev.on,
                on=cur.on,
                start=start,
                end=end,
                flow=cur.flow,
                market=market,
                currency=currency,
            )
        )
    return parts


def cumulative_series(parts: Sequence[DayParts]) -> list[CumulativePoint]:
    """Running totals, starting with the anchor close (all parts zero)."""
    if not parts:
        return []
    first = parts[0]
    points = [
        CumulativePoint(
            on=first.prev_on,
            value=first.start,
            flow=ZERO,
            market=ZERO,
            currency=ZERO,
            constant_currency=first.start,
        )
    ]
    flow = market = currency = ZERO
    with _exact():
        for p in parts:
            flow += p.flow
            market += p.market
            currency += p.currency
            points.append(
                CumulativePoint(
                    on=p.on,
                    value=p.end,
                    flow=flow,
                    market=market,
                    currency=currency,
                    constant_currency=p.end - currency,
                )
            )
    return points


def bridge(parts: Sequence[DayParts], label: str = "") -> Bridge:
    """The bridge over ``parts`` (adjacent days); raises on an empty range."""
    if not parts:
        raise ValueError("a bridge needs at least one day")
    with _exact():
        flows = sum((p.flow for p in parts), ZERO)
        market = sum((p.market for p in parts), ZERO)
        currency = sum((p.currency for p in parts), ZERO)
    return Bridge(
        label=label,
        start_on=parts[0].prev_on,
        end_on=parts[-1].on,
        start=parts[0].start,
        flows=flows,
        market=market,
        currency=currency,
        end=parts[-1].end,
    )


def _grouped(parts: Sequence[DayParts], key: Callable[[date], str]) -> list[Bridge]:
    groups: list[tuple[str, list[DayParts]]] = []
    for p in parts:
        k = key(p.on)
        if groups and groups[-1][0] == k:
            groups[-1][1].append(p)
        else:
            groups.append((k, [p]))
    return [bridge(g, label=k) for k, g in groups]


def month_totals(parts: Sequence[DayParts]) -> list[Bridge]:
    """One bridge per calendar month (by the date each move lands on)."""
    return _grouped(parts, lambda d: f"{d.year:04d}-{d.month:02d}")


def year_totals(parts: Sequence[DayParts]) -> list[Bridge]:
    """One bridge per calendar year (by the date each move lands on)."""
    return _grouped(parts, lambda d: f"{d.year:04d}")


def _best_worst(items: Sequence[Extreme]) -> tuple[Extreme | None, Extreme | None]:
    if not items:
        return None, None
    best = max(items, key=lambda e: e.currency)
    worst = min(items, key=lambda e: e.currency)
    return best, worst


def records(parts: Sequence[DayParts]) -> Records:
    """Best / worst day, month and year by currency part (first one wins a tie)."""
    days = [Extreme(p.on.isoformat(), p.currency) for p in parts]
    months = [Extreme(b.label, b.currency) for b in month_totals(parts)]
    years = [Extreme(b.label, b.currency) for b in year_totals(parts)]
    bd, wd = _best_worst(days)
    bm, wm = _best_worst(months)
    by, wy = _best_worst(years)
    return Records(bd, wd, bm, wm, by, wy)


def rolling_currency(parts: Sequence[DayParts], window: int) -> list[RollingPoint]:
    """Currency part summed over each run of ``window`` business days.

    One point per business day (Mon-Fri) with at least ``window`` business days
    of moves behind it. A window covers the moves landing on its business days
    plus any weekend / holiday rows between them.
    """
    if window <= 0:
        raise ValueError("window must be positive")
    business = [i for i, p in enumerate(parts) if p.on.weekday() < 5]
    points: list[RollingPoint] = []
    with _exact():
        prefix = [ZERO]
        for p in parts:
            prefix.append(prefix[-1] + p.currency)
        for k in range(window - 1, len(business)):
            hi = business[k] + 1
            lo = business[k - window] + 1 if k >= window else 0
            points.append(RollingPoint(parts[business[k]].on, window, prefix[hi] - prefix[lo]))
    return points


def _sign(value: Decimal) -> int:
    return 1 if value > 0 else -1 if value < 0 else 0


def current_run(months: Sequence[Bridge]) -> Run | None:
    """The streak of same-sign months ending at the last month (``None`` at a zero)."""
    if not months:
        return None
    sign = _sign(months[-1].currency)
    if sign == 0:
        return None
    length = 0
    total = ZERO
    with _exact():
        for m in reversed(months):
            if _sign(m.currency) != sign:
                break
            length += 1
            total += m.currency
    return Run(sign=sign, length=length, since=months[-length].label, currency=total)


def tailwind_share(months: Sequence[Bridge]) -> Decimal | None:
    """Share of months (0..1) whose currency part was positive; ``None`` if none."""
    if not months:
        return None
    return Decimal(sum(1 for m in months if m.currency > 0)) / Decimal(len(months))


def median_abs_daily(parts: Sequence[DayParts]) -> Decimal | None:
    """Median of ``|currency part|`` over the days; ``None`` if there are none."""
    if not parts:
        return None
    values = sorted(abs(p.currency) for p in parts)
    n = len(values)
    mid = n // 2
    if n % 2:
        return values[mid]
    with _exact():
        return (values[mid - 1] + values[mid]) / 2


def largest_day(parts: Sequence[DayParts]) -> Extreme | None:
    """The day with the largest ``|currency part|`` (earliest on a tie)."""
    if not parts:
        return None
    top = max(parts, key=lambda p: abs(p.currency))
    return Extreme(top.on.isoformat(), top.currency)


def months_of_contributions(effect: Decimal, contributions: Sequence[Decimal]) -> Decimal | None:
    """``effect`` as a number of average months of contributions.

    ``contributions`` are the monthly contribution amounts (reporting currency)
    to average over; ``None`` when there are none or the average is not positive.
    """
    if not contributions:
        return None
    with _exact():
        average = sum(contributions, ZERO) / Decimal(len(contributions))
    if average <= 0:
        return None
    return _CONVERT.divide(effect, average)


def session_legs(
    book: Mapping[str, Decimal],
    reporting: str,
    *,
    prev_close: Mapping[str, FxRate],
    session_open: Mapping[str, FxRate],
    session_close: Mapping[str, FxRate],
) -> SessionLegs:
    """Split a day's currency part at the session open, on the same (close) book."""
    outside = revaluation(book, reporting, rates_from=prev_close, rates_to=session_open)
    inside = revaluation(book, reporting, rates_from=session_open, rates_to=session_close)
    currency = revaluation(book, reporting, rates_from=prev_close, rates_to=session_close)
    return SessionLegs(outside=outside, inside=inside, currency=currency)
