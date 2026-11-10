"""One convention for "growth over a period": where it opens and which flows count.

Every period figure (Overview MTD / YTD, the holding-level MTD / YTD, the
Periods table, the day move) follows the same rule:

* the **opening value** is the value at the *close* of the day before the
  period starts (``period_start - 1 day``);
* the **flows** that count are the external ones dated ``>= period_start`` (and
  ``<= period_end``).

So a deposit (or, at holding level, a buy) dated on the first day sits in the
flows only, never in the opening value as well, and the first day's own market
move is inside the period. Pure: no I/O.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

ZERO = Decimal(0)
_ONE_DAY = timedelta(days=1)


@dataclass(frozen=True)
class PeriodWindow:
    """A reporting period ``[start, end]`` (both inclusive)."""

    start: date
    end: date

    @property
    def opening_date(self) -> date:
        """The day whose close is the period's opening value (``start - 1 day``)."""
        return self.start - _ONE_DAY

    def counts_flow(self, on: date) -> bool:
        """Whether an external flow dated ``on`` belongs to this period."""
        return self.start <= on <= self.end


def period_window(start: date, end: date) -> PeriodWindow:
    """The window from ``start`` to ``end`` (``end`` before ``start`` is rejected)."""
    if end < start:
        msg = f"period end {end} is before its start {start}"
        raise ValueError(msg)
    return PeriodWindow(start=start, end=end)


def month_to_date(as_of: date) -> PeriodWindow:
    """The calendar month of ``as_of`` up to ``as_of``."""
    return PeriodWindow(start=as_of.replace(day=1), end=as_of)


def year_to_date(as_of: date) -> PeriodWindow:
    """The calendar year of ``as_of`` up to ``as_of``."""
    return PeriodWindow(start=date(as_of.year, 1, 1), end=as_of)


def session_window(prev_session: date, session: date) -> PeriodWindow:
    """The day move from ``prev_session``'s close to ``session``'s close.

    Opens at the close of ``prev_session``; the flows are those dated after it
    and on or before ``session`` (a weekend deposit lands in Monday's move).
    """
    return period_window(prev_session + _ONE_DAY, max(session, prev_session + _ONE_DAY))


def net_flows(flows: Iterable[tuple[date, Decimal]], window: PeriodWindow) -> Decimal:
    """Signed sum of ``(date, amount)`` flows inside ``window`` (money in positive)."""
    return sum((amount for on, amount in flows if window.counts_flow(on)), start=ZERO)


def growth_after_flows(opening: Decimal, closing: Decimal, flows: Decimal) -> Decimal | None:
    """Simple growth net of the period's flows: ``(V1 - V0 - F) / (V0 + F)``.

    ``flows`` is the net money *into* the book during the period (deposits
    positive). The denominator is the money at work, ``V0 + F``; ``None`` when it
    is not positive (nothing at risk).
    """
    denom = opening + flows
    if denom <= ZERO:
        return None
    return (closing - opening - flows) / denom


def move_after_flows(opening: Decimal, closing: Decimal, flows: Decimal) -> Decimal:
    """The money move net of the period's flows: ``V1 - V0 - F``."""
    return closing - opening - flows
