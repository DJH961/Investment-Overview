"""EUR/USD at each US session's open and close, kept for good (v7.2).

The intraday samples (cache tier) carry the rate at each captured instant but are
pruned after about a week. Before they go, :func:`record_from_samples` keeps one
row per completed session with its open and close rate in ``fx_session_rates``
(ledger tier, so a cache reset does not wipe it; see
:mod:`investment_dashboard.models.fx_session_rate`). It runs at boot (backfilling
every session the stored samples still cover) and from the intraday capture
(once per session day, recording the sessions that have closed since).

Rows are only written for a session whose samples reach both its open and its
close (:func:`domain.fx_session.pick_session_rates`), and a recorded session is
never rewritten. The Currency page splits the currency effect inside / outside
market hours from the first recorded session on.
"""

from __future__ import annotations

import logging
import threading
from collections import defaultdict
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain.fx_session import pick_session_rates
from investment_dashboard.domain.market_hours import (
    is_trading_day,
    regular_session_close,
    regular_session_open,
)
from investment_dashboard.repositories import fx_session_rates_repo

log = logging.getLogger(__name__)

SOURCE_SAMPLES = "samples"
_EPOCH = datetime(1970, 1, 1)
_checked_lock = threading.Lock()
_checked_on: date | None = None


def _naive_utc(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(tzinfo=None) if at.tzinfo is not None else at


def record_from_samples(session: Session, *, now: datetime | None = None) -> int:
    """Record every completed session the stored samples cover and that is not stored yet.

    ``session`` is a ledger-tier session (the samples are read through the cache
    tier by :mod:`intraday_snapshots_service`). Returns the number of new rows.
    """
    from investment_dashboard.services import intraday_snapshots_service  # noqa: PLC0415

    now_utc = _naive_utc(now or datetime.now(UTC))
    samples = intraday_snapshots_service.fx_samples_between(session, _EPOCH, now_utc)
    by_day: dict[date, list[tuple[datetime, Decimal]]] = defaultdict(list)
    for at, fx in samples:
        by_day[intraday_snapshots_service.session_date_of(at)].append((at, fx))
    stored = fx_session_rates_repo.stored_dates(session)
    rows: list[fx_session_rates_repo.Row] = []
    for day in sorted(by_day):
        if day in stored or not is_trading_day(day):
            continue
        open_at = _naive_utc(regular_session_open(day))
        close_at = _naive_utc(regular_session_close(day))
        if now_utc < close_at:
            continue  # still trading: its close is not known yet
        picked = pick_session_rates(by_day[day], open_at=open_at, close_at=close_at)
        if picked is None:
            continue
        rows.append(
            (
                day,
                picked.open_rate,
                picked.close_rate,
                SOURCE_SAMPLES,
                picked.open_at,
                picked.close_at,
            )
        )
    count = fx_session_rates_repo.insert_missing(session, rows) if rows else 0
    if count:
        log.info(
            "FX session rates recorded: %d session(s), %s to %s",
            count,
            rows[0][0].isoformat(),
            rows[-1][0].isoformat(),
        )
    return count


def record_once_per_day(session: Session, *, now: datetime | None = None) -> int:
    """:func:`record_from_samples` at most once per exchange day (the capture hook)."""
    global _checked_on  # noqa: PLW0603 - a tiny process-wide throttle
    from investment_dashboard.domain.market_hours import exchange_today  # noqa: PLC0415

    today = exchange_today(now)
    with _checked_lock:
        if _checked_on == today:
            return 0
        _checked_on = today
    return record_from_samples(session, now=now)


def reset_throttle() -> None:
    """Forget the once-per-day throttle (tests)."""
    global _checked_on  # noqa: PLW0603
    with _checked_lock:
        _checked_on = None


def session_rates(session: Session) -> dict[date, tuple[Decimal, Decimal]]:
    """``{session_date: (open_rate, close_rate)}`` (USD per 1 EUR) of every recorded session."""
    return {
        r.session_date: (r.open_rate, r.close_rate) for r in fx_session_rates_repo.list_all(session)
    }
