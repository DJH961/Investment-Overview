"""Lightweight US-equity market-clock helper.

The dashboard's *Daily Growth* card wants to tell two situations apart:

* the **regular trading session is open right now** — prices and FX are moving
  intraday, so the card shows a live, time-stamped figure ("as of 15:42"); and
* the **session is closed** — the most recent print is a settled close, so the
  card pins to that date instead.

There is no exchange-calendar dependency in this project (and we deliberately
avoid adding one), so this helper models only the New York Stock Exchange's
*regular* weekday session, 09:30–16:00 America/New_York. It intentionally does
**not** know about market holidays or half-days: on those days it may report the
session as open, which at worst shows the live (rather than settled) wording for
a card whose numbers are identical either way. Keeping it dependency-free and
pure is worth that small imprecision.
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


def is_us_market_open(now: datetime | None = None) -> bool:
    """Return ``True`` when the NYSE regular session is open at ``now``.

    ``now`` defaults to the current instant (UTC). It may be naive (interpreted
    as already being in exchange time) or timezone-aware (converted to exchange
    time first). Weekends are always closed; holidays are not modelled (see the
    module docstring).
    """
    if now is None:
        now = datetime.now(UTC)
    local = now.astimezone(_MARKET_TZ) if now.tzinfo is not None else now
    if local.weekday() >= _SATURDAY:
        return False
    return _OPEN <= local.time() < _CLOSE


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
