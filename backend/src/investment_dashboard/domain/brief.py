"""The Daily Brief's window: which NYSE sessions passed since the last acknowledgement.

Pure calendar logic (no I/O). A *boundary* is a regular-session open or close from the
NYSE calendar (holidays skipped, half-days close 13:00 ET). The window is
``(last_ack, now]``:

* no marker yet (first visit) or ``now <= last_ack``: no Brief;
* one session touched: ``session`` (the figures are sent);
* several: ``sessions`` ("N sessions passed", no figures);
* no boundary, but the currency market reopened (Sunday 17:00 ET): ``fx_reopen``;
* otherwise: nothing.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from investment_dashboard.domain import market_hours

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
