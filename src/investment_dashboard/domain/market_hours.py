"""Lightweight US-equity market-clock helper.

The dashboard's *Daily Growth* card wants to tell two situations apart:

* the **regular trading session is open right now** — prices and FX are moving
  intraday, so the card shows a live, time-stamped figure ("as of 15:42"); and
* the **session is closed** — the most recent print is a settled close, so the
  card pins to that date instead.

This helper models the New York Stock Exchange's *regular* weekday session,
09:30–16:00 America/New_York, **and** the full-day NYSE market holidays (so a
stale carried-forward close on a holiday is never dressed up as a live,
time-stamped figure). The holiday calendar is computed, not table-driven, so it
keeps the module dependency-free while staying correct for any year — it mirrors
the browser companion's ``web/src/market-hours.ts``. Half-day early closes (a
1:00pm close on a few sessions) are deliberately **not** modelled: the worst
case there is showing the live (rather than settled) wording for a couple of
hours on numbers that are identical either way.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta, tzinfo
from zoneinfo import ZoneInfo

#: The exchange whose regular session defines "the market is open" for the
#: dashboard. The portfolio is US-equity heavy, so NYSE/Nasdaq hours are the
#: relevant clock for intraday vs. settled wording.
_MARKET_TZ = ZoneInfo("America/New_York")

#: Regular cash session bounds (local exchange time). Half-days are ignored.
_OPEN = time(9, 30)
_CLOSE = time(16, 0)

#: ``datetime.weekday()`` returns 5/6 for Saturday/Sunday.
_SATURDAY = 5

#: How recently a fresh price must have been pulled for a same-day figure to be
#: called *live* (rather than merely settled-today) while the market is open.
#: The live-price tick runs about once a minute, so a generous 15-minute window
#: keeps a brief provider hiccup from flickering "live" off, while a genuinely
#: stalled or unreachable feed (no fresh prices for many minutes) correctly stops
#: claiming to be live. Shared by the header chip, the per-row "As Of" badge and
#: the Daily Growth caption so all three agree on what "live" means.
LIVE_PRICE_WINDOW_SECONDS = 900.0


def feed_is_fresh(
    last_update_at: datetime | None,
    now: datetime | None,
    *,
    window_seconds: float = LIVE_PRICE_WINDOW_SECONDS,
) -> bool:
    """Whether a price pulled at ``last_update_at`` is still fresh enough to be live.

    Returns ``True`` only when a fresh price actually landed within
    ``window_seconds`` of ``now`` — i.e. we can genuinely access live data right
    now. ``now=None`` means "no clock to judge against", so the check is skipped
    (the caller keeps its non-recency behaviour); ``last_update_at=None`` means we
    have no evidence of a recent pull, so the feed is **not** considered live.

    Both instants may be naive (interpreted as UTC) or timezone-aware; they are
    normalised before comparison so a naive cache timestamp and an aware ``now``
    compare correctly.
    """
    if now is None:
        return True
    if last_update_at is None:
        return False
    updated = (
        last_update_at.replace(tzinfo=UTC) if last_update_at.tzinfo is None else last_update_at
    )
    current = now.replace(tzinfo=UTC) if now.tzinfo is None else now
    age = (current - updated).total_seconds()
    return 0 <= age <= window_seconds


def _observed(holiday: date) -> date:
    """The weekday the market is actually closed for a fixed-date ``holiday``.

    The NYSE observes a Saturday holiday on the preceding Friday and a Sunday
    holiday on the following Monday; any other weekday is observed on the day
    itself.
    """
    weekday = holiday.weekday()
    if weekday == _SATURDAY:  # Saturday → observed Friday.
        return holiday - timedelta(days=1)
    if weekday == _SATURDAY + 1:  # Sunday → observed Monday.
        return holiday + timedelta(days=1)
    return holiday


def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    """The ``nth`` ``weekday`` (Mon=0 … Sun=6) of ``month`` in ``year``."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + (nth - 1) * 7)


def _last_weekday(year: int, month: int, weekday: int) -> date:
    """The last ``weekday`` (Mon=0 … Sun=6) of ``month`` in ``year``."""
    next_month = date(year + (month == 12), (month % 12) + 1, 1)
    last_day = next_month - timedelta(days=1)
    offset = (last_day.weekday() - weekday) % 7
    return last_day - timedelta(days=offset)


def _easter_sunday(year: int) -> date:
    """Easter Sunday for ``year`` (anonymous Gregorian computus)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    ell = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ell) // 451
    month, day = divmod(h + ell - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _holidays_for_year(year: int) -> frozenset[date]:
    """The set of full-day NYSE market holidays observed in ``year``."""
    holidays = {
        _observed(date(year, 1, 1)),  # New Year's Day
        _nth_weekday(year, 1, 0, 3),  # MLK Day — 3rd Monday of January
        _nth_weekday(year, 2, 0, 3),  # Washington's Birthday — 3rd Monday of February
        _easter_sunday(year) - timedelta(days=2),  # Good Friday
        _last_weekday(year, 5, 0),  # Memorial Day — last Monday of May
        _observed(date(year, 7, 4)),  # Independence Day
        _nth_weekday(year, 9, 0, 1),  # Labor Day — 1st Monday of September
        _nth_weekday(year, 11, 3, 4),  # Thanksgiving — 4th Thursday of November
        _observed(date(year, 12, 25)),  # Christmas Day
    }
    if year >= 2022:  # Juneteenth — an NYSE holiday from 2022.
        holidays.add(_observed(date(year, 6, 19)))
    # New Year's Day of the *next* year is observed on 31 Dec when 1 Jan is a
    # Saturday, so it lands back in this year — include it so that day reads as a
    # holiday too (a refinement over the per-year web calendar).
    next_new_year = _observed(date(year + 1, 1, 1))
    if next_new_year.year == year:
        holidays.add(next_new_year)
    return frozenset(holidays)


def is_us_market_holiday(day: date) -> bool:
    """Return ``True`` when ``day`` is a full-day NYSE market holiday.

    Half-day early closes are **not** treated as holidays (see the module
    docstring); the market is genuinely open on those days, just for a shorter
    session.
    """
    return day in _holidays_for_year(day.year)


def is_trading_day(day: date) -> bool:
    """Return ``True`` when ``day`` is a regular NYSE trading session.

    A trading day is any weekday (Mon–Fri) that is not a full-day market
    holiday. Half-day early closes still count as trading days (the market is
    genuinely open, just for a shorter session — see :func:`is_us_market_holiday`).

    Charts use this to drop non-trading days from value-over-time series: their
    plotted value is only the prior session's close carried forward, so they add
    flat, meaningless steps. Skipping them lets the line's own smoothing bridge
    the gap instead.
    """
    return day.weekday() < _SATURDAY and not is_us_market_holiday(day)


def is_us_trading_day(now: datetime | None = None) -> bool:
    """Return ``True`` when ``now`` falls on a regular NYSE trading day.

    The instant-aware companion of :func:`is_trading_day`: it resolves ``now`` to
    the exchange-local (New York) calendar date first, so it is correct regardless
    of the caller's timezone and stays ``True`` overnight and after-hours on a
    trading day — only weekends and full-day holidays read ``False``. The Overview
    uses it to tell a genuine *non-market day* (no session at all, so "today" is
    purely the overnight FX drift) apart from a trading day that merely happens to
    be shut right now.

    ``now`` defaults to the current instant (UTC). It may be naive (interpreted as
    exchange time) or timezone-aware (converted to exchange time first).
    """
    if now is None:
        now = datetime.now(UTC)
    local = now.astimezone(_MARKET_TZ) if now.tzinfo is not None else now
    return is_trading_day(local.date())


def is_us_market_open(now: datetime | None = None) -> bool:
    """Return ``True`` when the NYSE regular session is open at ``now``.

    ``now`` defaults to the current instant (UTC). It may be naive (interpreted
    as already being in exchange time) or timezone-aware (converted to exchange
    time first). Weekends **and** full-day market holidays are always closed, so
    a randomly-closed session (a holiday) is never mistaken for an open one;
    otherwise the regular 09:30–16:00 America/New_York window applies.
    """
    if now is None:
        now = datetime.now(UTC)
    local = now.astimezone(_MARKET_TZ) if now.tzinfo is not None else now
    if local.weekday() >= _SATURDAY:
        return False
    if is_us_market_holiday(local.date()):
        return False
    return _OPEN <= local.time() < _CLOSE


def latest_settled_session_date(now: datetime | None = None) -> date:
    """The exchange date of the most recent NYSE session whose 16:00 close has passed.

    Holiday-aware (unlike :func:`previous_trading_day`): today counts only once
    its 16:00 America/New_York close is in the past, otherwise the date rolls
    back over weekends and full-day market holidays to the prior trading day.
    This is "the close we should already be holding" — the desktop mirror of the
    browser companion's ``latestSettledSessionDate`` — used to decide whether a
    cached price is current enough that the feed needn't be polled again.

    ``now`` defaults to the current instant (UTC). It may be naive (interpreted
    as exchange time) or timezone-aware (converted to exchange time first).
    """
    if now is None:
        now = datetime.now(UTC)
    local = now.astimezone(_MARKET_TZ) if now.tzinfo is not None else now
    day = local.date()
    settled_today = (
        local.weekday() < _SATURDAY and not is_us_market_holiday(day) and local.time() >= _CLOSE
    )
    if settled_today:
        return day
    day -= timedelta(days=1)
    while day.weekday() >= _SATURDAY or is_us_market_holiday(day):
        day -= timedelta(days=1)
    return day


def previous_trading_day(today: date) -> date:
    """The most recent weekday strictly *before* ``today``.

    A dependency-free stand-in for "the last settled trading session" — like
    :func:`is_us_market_open` it models only the weekly Mon–Fri rhythm and
    ignores exchange holidays (see the module docstring). Saturday/Sunday roll
    back to Friday; any other weekday rolls back to the prior weekday.

    Used to tell a *genuinely* stale price (its newest close is more than one
    trading day behind, which usually means the provider is failing for that
    symbol) apart from one that is merely waiting on the next intraday refresh
    tick — the latter is normal overnight/at-weekend and must not be flagged.
    """
    day = today - timedelta(days=1)
    while day.weekday() >= _SATURDAY:
        day -= timedelta(days=1)
    return day


def trading_days_before(today: date, n: int) -> date:
    """The weekday that is ``n`` trading days strictly before ``today``.

    ``n == 1`` is exactly :func:`previous_trading_day`; larger ``n`` rolls back
    further, skipping weekends. Like the rest of this module it ignores exchange
    holidays, so callers that need to absorb a holiday (which leaves no settled
    print on a modelled "trading" day) add an extra day of grace on top.
    """
    if n <= 0:
        return today
    day = today
    for _ in range(n):
        day = previous_trading_day(day)
    return day


def regular_session_close(day: date, *, tz: tzinfo | None = None) -> datetime:
    """The NYSE regular-session close (16:00 America/New_York) on ``day``.

    Returns a timezone-aware instant marking "the last market action" of a
    settled trading day — the moment a same-day-but-closed price is *from*. When
    ``tz`` is given the instant is converted to that display timezone (so a CET
    user reads the 22:00 local close); otherwise it stays in exchange time.

    Like the rest of this module it ignores holidays and half-days (see the
    module docstring): the close is always modelled as 16:00 exchange time.
    """
    close = datetime.combine(day, _CLOSE, tzinfo=_MARKET_TZ)
    return close.astimezone(tz) if tz is not None else close
