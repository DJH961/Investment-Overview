"""The Daily Brief's window: which NYSE sessions passed since the last acknowledgement.

Pure calendar logic (no I/O). A *boundary* is a regular-session open or close from the
NYSE calendar (holidays skipped, half-days close 13:00 ET). The window is
``(last_ack, now]``:

* no marker yet (first visit) or ``now <= last_ack``: no Brief;
* one session touched: ``session`` (the figures are sent);
* several: ``sessions`` ("N sessions passed", no figures);
* no boundary, but the currency market reopened (Sunday 17:00 ET): ``fx_reopen``;
* otherwise: nothing.

Also the window's currency effect (:func:`currency_effect_since`), pure maths on a
book of native holdings.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo

from investment_dashboard.domain import market_hours
from investment_dashboard.domain.late_data import Holding, value_at_rate
from investment_dashboard.domain.session_fx import fx_buying_power_split

_ET = ZoneInfo("America/New_York")
#: Exchange days scanned at most; an older acknowledgement only sees the newest part.
MAX_SCAN_DAYS = 3700
_SUNDAY = 6
_FOREX_REOPEN = time(17, 0)


@dataclass(frozen=True)
class Boundary:
    at: datetime  # aware UTC
    kind: Literal["open", "close"]
    session_date: date


@dataclass(frozen=True)
class BriefWindow:
    start: datetime
    end: datetime
    kind: Literal["session", "sessions", "fx_reopen"]
    boundaries: tuple[Boundary, ...]
    sessions: tuple[date, ...]

    @property
    def sessions_passed(self) -> int:
        return len(self.sessions)


def _utc(moment: datetime) -> datetime:
    """Aware UTC; a naive instant is taken as UTC."""
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def session_boundaries(start: datetime, end: datetime) -> list[Boundary]:
    """Every NYSE open/close with ``start < at <= end``, oldest first."""
    start, end = _utc(start), _utc(end)
    if end <= start:
        return []
    first = start.astimezone(_ET).date()
    last = end.astimezone(_ET).date()
    if (last - first).days > MAX_SCAN_DAYS:
        first = last - timedelta(days=MAX_SCAN_DAYS)
    out: list[Boundary] = []
    day = first
    while day <= last:
        if market_hours.is_trading_day(day):
            opened = market_hours.regular_session_open(day).astimezone(UTC)
            closed = market_hours.regular_session_close(day).astimezone(UTC)
            if start < opened <= end:
                out.append(Boundary(at=opened, kind="open", session_date=day))
            if start < closed <= end:
                out.append(Boundary(at=closed, kind="close", session_date=day))
        day += timedelta(days=1)
    return out


def _fx_reopen_in(start: datetime, end: datetime) -> bool:
    """True when a Sunday 17:00 ET lies in ``(start, end]``."""
    day = end.astimezone(_ET).date()
    for _ in range(8):
        if day.weekday() == _SUNDAY:
            reopen = datetime.combine(day, _FOREX_REOPEN, tzinfo=_ET).astimezone(UTC)
            if reopen <= end:
                return reopen > start
        day -= timedelta(days=1)
    return False


def brief_window(last_ack: datetime | None, now: datetime) -> BriefWindow | None:
    """The Brief's window since ``last_ack``, or ``None`` when there is nothing to show."""
    if last_ack is None:
        return None
    start, end = _utc(last_ack), _utc(now)
    if end <= start:
        return None
    boundaries = session_boundaries(start, end)
    if not boundaries:
        if _fx_reopen_in(start, end):
            return BriefWindow(start, end, "fx_reopen", (), ())
        return None
    sessions = tuple(dict.fromkeys(b.session_date for b in boundaries))
    kind: Literal["session", "sessions"] = "session" if len(sessions) == 1 else "sessions"
    return BriefWindow(start, end, kind, tuple(boundaries), sessions)


@dataclass(frozen=True)
class CurrencyEffectSince:
    """The currency effect on the book over the Brief's window, in one currency.

    ``amount`` = the book at ``rate_now`` minus the same book at ``rate_then``
    (holdings and prices held constant, only the EUR/USD rate moves);
    ``value_then`` = that book at ``rate_then``; ``pct = amount / value_then``.
    """

    amount: Decimal
    pct: Decimal
    value_then: Decimal


def currency_effect_since(
    holdings: Iterable[Holding], *, rate_then: Decimal, rate_now: Decimal
) -> dict[str, CurrencyEffectSince | None] | None:
    """Per reporting currency (``"EUR"``, ``"USD"``): the rate's effect since ``rate_then``.

    The same revaluation as the Overview's currency box and the day rule's currency
    legs (``metrics_service.fx_revaluation``: :func:`value_at_rate` of one book at
    two rates). 💱 Each currency is valued from the NATIVE amounts: in EUR, USD
    holdings move by ``usd x (1/rate_now - 1/rate_then)``; in USD, USD holdings
    contribute exactly 0 and EUR holdings ``eur x (rate_now - rate_then)``. The USD
    figure is never derived from the EUR one. A currency whose ``value_then`` is not
    positive is ``None`` (no percentage); ``None`` overall when a rate is unusable.
    """
    if rate_then <= 0 or rate_now <= 0:
        return None
    book = list(holdings)
    eur_then, usd_then = value_at_rate(book, rate_then)
    eur_now, usd_now = value_at_rate(book, rate_now)
    out: dict[str, CurrencyEffectSince | None] = {}
    for ccy, then, now in (("EUR", eur_then, eur_now), ("USD", usd_then, usd_now)):
        amount = now - then
        out[ccy] = CurrencyEffectSince(amount, amount / then, then) if then > 0 else None
    return out


@dataclass(frozen=True)
class InvestingPowerSince:
    """What the regular euro amount buys in dollars now versus at the window's start."""

    amount_eur: Decimal
    amount_usd_then: Decimal
    amount_usd_now: Decimal
    #: ``amount_usd_now - amount_usd_then`` = ``amount_eur x (rate_now - rate_then)``.
    net: Decimal
    #: ``net / amount_usd_then`` (= ``rate_now / rate_then - 1``).
    pct: Decimal


def investing_power_since(
    amount_eur: Decimal, *, rate_then: Decimal, rate_now: Decimal
) -> InvestingPowerSince | None:
    """The USD view's currency line over the window: the Overview's investing power.

    The same maths as ``investing_power_usd`` (:func:`fx_buying_power_split`'s whole
    move with ``prev_fx = rate_then``): a fixed number of euros buys
    ``amount_eur x rate`` dollars. ``None`` without a positive amount or rates.
    """
    split = fx_buying_power_split(
        market_open=False,
        amount_eur=amount_eur,
        live_fx=rate_now,
        prev_fx=rate_then,
        session_close_fx=None,
    )
    if split.total_usd is None:
        return None
    then = amount_eur * rate_then
    now = amount_eur * rate_now
    return InvestingPowerSince(amount_eur, then, now, split.total_usd, split.total_usd / then)
