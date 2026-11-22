"""Pick a session's open and close EUR/USD from its intraday samples (pure).

A session's rates are recorded only when the samples really reach both ends: the
first sample must lie within :data:`OPEN_TOLERANCE` after the open and the last
within :data:`CLOSE_TOLERANCE` before the close (the same close gate as
``intraday_snapshots_service.session_close_rate``). A track that starts late or
stops mid-session gives no row rather than a wrong one, so the inside / outside
split is only ever shown on honest data.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

#: The first sample may be this late after the 09:30 ET open.
OPEN_TOLERANCE = timedelta(minutes=15)
#: The last sample may be this early before the close.
CLOSE_TOLERANCE = timedelta(minutes=5)


@dataclass(frozen=True)
class SessionRates:
    open_rate: Decimal
    close_rate: Decimal
    open_at: datetime
    close_at: datetime


def pick_session_rates(
    samples: Sequence[tuple[datetime, Decimal]],
    *,
    open_at: datetime,
    close_at: datetime,
) -> SessionRates | None:
    """The open / close rates of one session, or ``None`` when the samples fall short.

    ``samples`` are ``(instant, rate)`` pairs (any order, same clock as ``open_at``
    / ``close_at``); rates that are not positive and instants outside the session
    are ignored.
    """
    inside = sorted((at, fx) for at, fx in samples if fx > 0 and open_at <= at <= close_at)
    if not inside:
        return None
    first_at, first_fx = inside[0]
    last_at, last_fx = inside[-1]
    if first_at - open_at > OPEN_TOLERANCE or close_at - last_at > CLOSE_TOLERANCE:
        return None
    return SessionRates(open_rate=first_fx, close_rate=last_fx, open_at=first_at, close_at=last_at)
