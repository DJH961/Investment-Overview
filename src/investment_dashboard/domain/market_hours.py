"""Best-effort "is the market open right now?" helper.

The desktop only stores daily closes, so a holding's price freshness is a *date*
rather than a ticking quote. To let the Holdings page promote today's price to a
live status word ("LIVE" while the market trades, "TODAY" once it has closed) we
need a lightweight notion of whether the relevant exchange is currently open.

This is intentionally approximate: it keys off the instrument's quote currency
(we do not ingest an exchange/MIC) and checks the weekday and local clock against
that market's regular session. Public holidays and intraday breaks are ignored —
the worst case is a stale "LIVE"/"TODAY" label on an exchange holiday, never a
wrong price. Unknown currencies are treated as closed so the UI falls back to the
plain date.
"""

from __future__ import annotations

from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

#: Regular-session hours per quote currency: ``(IANA tz, open, close)``. Times
#: are local to the exchange. Kept deliberately small — extend as needed.
_MARKET_SESSIONS: dict[str, tuple[str, time, time]] = {
    "USD": ("America/New_York", time(9, 30), time(16, 0)),
    "CAD": ("America/Toronto", time(9, 30), time(16, 0)),
    "EUR": ("Europe/Amsterdam", time(9, 0), time(17, 30)),
    "GBP": ("Europe/London", time(8, 0), time(16, 30)),
    "CHF": ("Europe/Zurich", time(9, 0), time(17, 30)),
    "JPY": ("Asia/Tokyo", time(9, 0), time(15, 0)),
    "AUD": ("Australia/Sydney", time(10, 0), time(16, 0)),
    "HKD": ("Asia/Hong_Kong", time(9, 30), time(16, 0)),
}


def is_market_open(currency: str | None, now: datetime | None = None) -> bool:
    """Whether the exchange for ``currency``-quoted securities is open at ``now``.

    ``now`` defaults to the current instant and may be naive (treated as UTC) or
    timezone-aware. Returns ``False`` for an unknown/unmapped currency, on
    weekends, or outside the market's regular session.
    """
    if currency is None:
        return False
    session = _MARKET_SESSIONS.get(currency.upper())
    if session is None:
        return False
    tz_name, open_at, close_at = session

    instant = datetime.now(tz=UTC) if now is None else now
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=UTC)
    local = instant.astimezone(ZoneInfo(tz_name))

    if local.weekday() >= 5:  # Saturday / Sunday.
        return False
    return open_at <= local.time() <= close_at
