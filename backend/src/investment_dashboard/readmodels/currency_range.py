"""One meaning per range for the whole Currency page (7.3.1).

Every Currency section (rate chart, Impact, Exposure, Scenarios, Conversions) turns
the page range into dates here, so a range covers the same days everywhere:

- ``1d`` / ``1w``: today, live (1D = since the last close; 1W = the last seven days
  up to now), drawn intraday.
- ``1m`` .. ``10y`` / ``ytd``: calendar windows ending now (the settled days through
  yesterday plus today's live move).
- ``all``: **your investing window only**, from the first transaction to now. Nothing
  dated before the first transaction is quoted.
- ``max``: the whole rate history (since 1999). The part before the first transaction
  is context only (``context_until``): the rate's story before you started, never
  added to your own figures.
- ``YYYY``: one calendar year (live only for the current year).

A window is ``(after, through]`` on settled closes (``after`` is the close it starts
from, exclusive, so adjacent windows chain exactly), plus ``live`` for today.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.services import fx_service

INTRADAY_RANGES = frozenset({"1d", "1w"})
WEEKLY_RANGES = frozenset({"10y", "max"})
MONTHS = {"1m": 1, "3m": 3, "1y": 12, "3y": 36, "5y": 60, "10y": 120}
PAGE_RANGES = ("1d", "1w", "1m", "3m", "ytd", "1y", "all", "5y", "10y", "max")


def minus_months(day: date, months: int) -> date:
    """``day`` shifted back by whole months (clamped to the month's last day)."""
    total = day.year * 12 + (day.month - 1) - months
    year, month = divmod(total, 12)
    month += 1
    for dd in (day.day, 30, 29, 28):
        try:
            return date(year, month, dd)
        except ValueError:
            continue
    return date(year, month, 28)  # pragma: no cover - unreachable


def last_settled_day(today: date | None = None) -> date:
    """The last close the daily parts run through (yesterday, exchange date)."""
    return (today or exchange_today()) - timedelta(days=1)


@dataclass(frozen=True)
class Window:
    """A page range as dates. ``after < day <= through`` are the settled days."""

    key: str
    after: date
    through: date
    #: Today's live move belongs to the range (the range ends now).
    live: bool
    #: Drawn from intraday samples (1D / 1W).
    intraday: bool
    #: The first transaction (``None`` for an empty ledger).
    first: date | None
    #: ``max`` only: days on or before this are before you started (context only).
    context_until: date | None = None

    @property
    def start(self) -> date:
        """The first calendar day inside the range."""
        return self.after + timedelta(days=1)

    @property
    def start_on(self) -> date:
        """The day a chart of the range starts on: the close the range is measured from
        (``after``), or for ``all`` the first transaction (never a day before it)."""
        if self.key in ("all", "max"):
            return self.start
        return self.after

    @property
    def own_after(self) -> date:
        """``after`` clamped to your investing window (never before the first transaction)."""
        if self.first is None:
            return self.after
        return max(self.after, self.first - timedelta(days=1))

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "start": self.start_on.isoformat(),
            "through": self.through.isoformat(),
            "live": self.live,
            "intraday": self.intraday,
            "context_until": self.context_until.isoformat() if self.context_until else None,
        }


def resolve(range_key: str, today: date, first: date | None) -> Window:  # noqa: PLR0911
    """The window for ``range_key`` on ``today`` (exchange date)."""
    end = last_settled_day(today)
    key = range_key.lower()
    if key == "max":
        after = fx_service.HISTORY_START - timedelta(days=1)
        ctx = first - timedelta(days=1) if first is not None and first > after else None
        return Window(key, after, end, live=True, intraday=False, first=first, context_until=ctx)
    if key == "all":
        after = first - timedelta(days=1) if first is not None else end
        return Window(key, after, end, live=True, intraday=False, first=first)
    if key == "ytd":
        return Window(key, date(today.year - 1, 12, 31), end, True, False, first)
    if key.isdigit():
        year = int(key)
        return Window(
            key,
            date(year - 1, 12, 31),
            min(date(year, 12, 31), end),
            live=year == today.year,
            intraday=False,
            first=first,
        )
    if key == "1d":
        return Window(key, end, end, live=True, intraday=True, first=first)
    if key == "1w":
        return Window(key, today - timedelta(days=7), end, live=True, intraday=True, first=first)
    if key in MONTHS:
        return Window(key, minus_months(today, MONTHS[key]), end, True, False, first)
    raise ValueError(f"unknown range {range_key!r}")


def start_rate(daily: list[tuple[date, Decimal]], window: Window) -> tuple[date, Decimal] | None:
    """The rate a range's change is measured from, the same for every section.

    The close the range starts from (the last fixing on or before ``after``, so 1Y
    and Impact's 1Y chain from the same close). ``all`` starts at the first fixing
    inside your investing window: nothing before your first transaction is quoted.
    ``daily`` is sorted by date.
    """
    if not daily:
        return None
    if window.key == "all":
        return next(((d, r) for d, r in daily if d >= window.start_on), daily[-1])
    i = bisect.bisect_right([d for d, _ in daily], window.after)
    return daily[i - 1] if i else daily[0]
