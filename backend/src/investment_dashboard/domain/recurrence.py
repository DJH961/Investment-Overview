"""Recurring plans (7.3, P14): due dates and estimate pricing. Pure, no I/O.

A plan repeats every ``every`` days, weeks or months:

* **days**: ``start + k * every`` days (the anchor is not used);
* **weeks**: the first date on or after ``start`` that falls on the anchor weekday
  (Monday = 0; default the start date's own weekday), then every ``every`` weeks;
* **months**: the anchor day of month (default the start date's day), clamped to the
  month's length (anchor 31 gives 30 Apr, 28/29 Feb), then every ``every`` months. The
  first occurrence is the first on or after ``start``. Clamping never drifts: each date
  is derived from the anchor, not from the previous (clamped) date.

The window arguments make catching up a long gap equal to the union of short steps:
``due_dates(a, b)`` = ``due_dates(a, m)`` + ``due_dates(m + 1 day, b)``.

Also here: rolling a buy's due date to its NYSE session, and the estimated conversion
rate (``ecb * (1 + provider_avg_off_pct)``).
"""

from __future__ import annotations

import calendar
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from investment_dashboard.domain.market_hours import is_trading_day

UNITS: frozenset[str] = frozenset({"days", "weeks", "months"})
_MAX_WEEKDAY = 6
_MAX_MONTH_DAY = 31


@dataclass(frozen=True)
class Cadence:
    unit: str
    every: int
    #: Weekday 0-6 for ``weeks``, day of month 1-31 for ``months``; ``None`` = the start's.
    anchor: int | None = None

    def __post_init__(self) -> None:
        if self.unit not in UNITS:
            raise ValueError(f"unit must be one of {sorted(UNITS)}")
        if self.every < 1:
            raise ValueError("every must be at least 1")
        if self.anchor is not None:
            if self.unit == "weeks" and not 0 <= self.anchor <= _MAX_WEEKDAY:
                raise ValueError("weekday anchor must be 0 (Monday) to 6 (Sunday)")
            if self.unit == "months" and not 1 <= self.anchor <= _MAX_MONTH_DAY:
                raise ValueError("day-of-month anchor must be 1 to 31")


def _month_day(month0: int, day: int) -> date:
    """``day`` clamped into absolute month ``month0`` (``year * 12 + month - 1``)."""
    year, m = divmod(month0, 12)
    return date(year, m + 1, min(day, calendar.monthrange(year, m + 1)[1]))


def _occurrences(cadence: Cadence, start: date) -> Iterator[date]:
    """Every occurrence from ``start`` on, ascending, without gaps or repeats."""
    if cadence.unit == "days":
        current = start
        step = timedelta(days=cadence.every)
        while True:
            yield current
            current += step
    elif cadence.unit == "weeks":
        weekday = start.weekday() if cadence.anchor is None else cadence.anchor
        first = start + timedelta(days=(weekday - start.weekday()) % 7)
        step = timedelta(weeks=cadence.every)
        current = first
        while True:
            yield current
            current += step
    else:
        day = start.day if cadence.anchor is None else cadence.anchor
        month0 = start.year * 12 + start.month - 1
        if _month_day(month0, day) < start:
            month0 += 1
        while True:
            yield _month_day(month0, day)
            month0 += cadence.every


def due_dates(
    cadence: Cadence,
    *,
    start: date,
    end: date | None,
    window_from: date,
    window_to: date,
) -> list[date]:
    """Due dates of a plan within ``[window_from, window_to]`` (inclusive), ascending.

    Never earlier than ``start`` nor later than ``end`` (when set).
    """
    upper = window_to if end is None else min(window_to, end)
    lower = max(window_from, start)
    if upper < lower:
        return []
    out: list[date] = []
    for day in _occurrences(cadence, start):
        if day > upper:
            break
        if day >= lower:
            out.append(day)
    return out


def next_due(cadence: Cadence, *, start: date, end: date | None, after: date) -> date | None:
    """The first due date strictly after ``after`` (``None`` when the plan has ended)."""
    for day in _occurrences(cadence, start):
        if end is not None and day > end:
            return None
        if day > after:
            return day
    return None  # pragma: no cover - the generator is infinite


def roll_to_session(day: date) -> date:
    """``day`` itself when it is an NYSE session, else the next session (buys)."""
    while not is_trading_day(day):
        day += timedelta(days=1)
    return day


def buy_figures(
    *, close: Decimal, amount: Decimal | None, shares: Decimal | None
) -> tuple[Decimal, Decimal]:
    """``(quantity, total)`` of an estimated buy at ``close`` (fees 0).

    Amount-based plans get ``quantity = amount / close``; share-based plans get
    ``total = shares * close``.
    """
    if close <= 0:
        raise ValueError("close must be positive")
    if shares is not None:
        return shares, shares * close
    if amount is None:
        raise ValueError("a buy plan needs an amount or shares")
    return amount / close, amount


def estimated_conversion(
    *, eur_sent: Decimal, ecb_rate: Decimal, avg_off_pct: Decimal | None
) -> tuple[Decimal, Decimal]:
    """``(rate, usd_received)`` of an estimated conversion.

    ``rate = ecb * (1 + avg_off_pct)``; plain ECB when the provider has no history.
    """
    if eur_sent <= 0 or ecb_rate <= 0:
        raise ValueError("eur_sent and ecb_rate must be positive")
    rate = ecb_rate * (1 + (avg_off_pct or Decimal(0)))
    return rate, eur_sent * rate
