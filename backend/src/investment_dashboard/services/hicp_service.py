"""Euro-area HICP in the cache tier (7.4 P10), modelled on ``risk_free_service``.

The end-of-day job calls :func:`refresh_if_due`: at most one ECB call per UTC day
(a success or a failure both count), which stores the monthly index in
``hicp_index``. Readers use :func:`get_index`. No hypothetical fallback: with no
index on file the real return is simply unavailable.

Every fetch leaves one line in the ``market_data`` activity log (months stored or
the failure), never anything personal.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.adapters import ecb_hicp
from investment_dashboard.repositories import hicp_repo

log = logging.getLogger(__name__)

SERIES = ecb_hicp.SERIES_KEY
SOURCE_LABEL = ecb_hicp.SOURCE_LABEL
#: First month pulled into an empty cache (well before any ledger).
FIRST_MONTH = "2000-01"
#: Months re-read before the latest stored one (Eurostat revises recent months).
REVISION_MONTHS = 12

Fetcher = Callable[..., list[ecb_hicp.HicpMonth]]

_lock = threading.Lock()
#: UTC day of the last attempt in this process (success or failure).
_last_attempt: dict[str, date | None] = {"day": None}


def reset_for_tests() -> None:
    with _lock:
        _last_attempt["day"] = None


def _naive_utc(now: datetime) -> datetime:
    return now.astimezone(UTC).replace(tzinfo=None) if now.tzinfo else now


def _months_back(month: str, n: int) -> str:
    year, mon = int(month[:4]), int(month[5:7])
    total = year * 12 + (mon - 1) - n
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def get_index(session: Session) -> dict[str, Decimal]:
    """``{"YYYY-MM": value}``, empty before the first fetch."""
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return hicp_repo.get_series(cache, SERIES)


def refresh(
    session: Session, *, fetcher: Fetcher | None = None, now: datetime | None = None
) -> int:
    """Fetch the index and store it; returns the months written. Raises on failure."""
    from investment_dashboard.db import cache_read_session, cache_write_session  # noqa: PLC0415

    stamp = _naive_utc(now or datetime.now(UTC))
    fetch = fetcher or ecb_hicp.fetch_index
    with cache_read_session(session) as cache:
        latest = hicp_repo.latest_month(cache, SERIES)
    start = FIRST_MONTH if latest is None else _months_back(latest, REVISION_MONTHS)
    try:
        months = fetch(start_month=start)
    except Exception as exc:
        activity("market_data").warning("HICP fetch from %s failed: %s", start, type(exc).__name__)
        raise
    with cache_write_session(session) as cache:
        written = hicp_repo.upsert(
            cache, SERIES, ((m.month, m.value) for m in months), fetched_at=stamp
        )
    newest = months[-1].month if months else latest
    activity("market_data").info(
        "HICP index fetched from %s: %d month(s), latest %s", start, written, newest or "none"
    )
    return written


def is_due(session: Session, *, now: datetime | None = None) -> bool:
    """No attempt yet today (UTC) in this process, and no stored fetch from today."""
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    today = _naive_utc(now or datetime.now(UTC)).date()
    with _lock:
        if _last_attempt["day"] == today:
            return False
    with cache_read_session(session) as cache:
        last = hicp_repo.last_fetched_at(cache, SERIES)
    return last is None or last.date() != today


def refresh_if_due(*, fetcher: Fetcher | None = None, now: datetime | None = None) -> bool:
    """End-of-day step: fetch once a day. ``False`` only when a due fetch failed."""
    from investment_dashboard.db import cache_session_scope  # noqa: PLC0415

    moment = now or datetime.now(UTC)
    try:
        with cache_session_scope() as cache:
            if not is_due(cache, now=moment):
                return True
            with _lock:
                _last_attempt["day"] = _naive_utc(moment).date()
            refresh(cache, fetcher=fetcher, now=moment)
    except Exception:
        log.warning("HICP refresh failed; the real return keeps the stored index", exc_info=True)
        return False
    return True
