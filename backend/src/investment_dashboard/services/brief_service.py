"""The Daily Brief's acknowledgement marker (``brief.last_ack_at`` in app config).

Stored as an ISO UTC string. It never moves backwards and never past the server clock.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.services import app_config_service

CONFIG_KEY = "brief.last_ack_at"


def _utc(moment: datetime) -> datetime:
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def get_last_ack(session: Session) -> datetime | None:
    """The stored marker (aware UTC), or ``None`` before the first visit."""
    raw = app_config_service.get(session, CONFIG_KEY)
    if not raw:
        return None
    try:
        return _utc(datetime.fromisoformat(raw))
    except ValueError:
        return None


def _store(session: Session, moment: datetime) -> None:
    app_config_service.set_value(session, CONFIG_KEY, _utc(moment).isoformat())


def init_marker(session: Session, now: datetime) -> datetime:
    """First visit: set the marker to ``now`` (no Brief). Returns the marker."""
    current = get_last_ack(session)
    if current is not None:
        return current
    _store(session, now)
    return _utc(now)


def ack(session: Session, *, seen_at: datetime | None, now: datetime) -> datetime:
    """Advance the marker to ``min(seen_at or now, now)``, never backwards."""
    now = _utc(now)
    target = min(_utc(seen_at) if seen_at is not None else now, now)
    current = get_last_ack(session)
    if current is not None and current > target:
        target = current
    _store(session, target)
    activity("changes").info("daily brief acknowledged up to %s", target.isoformat())
    return target
