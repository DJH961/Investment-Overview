"""Snapshots service — read-through cache for daily portfolio EUR value.

Today's snapshot is always recomputed (intra-day prices keep moving);
historical snapshots are computed once and reused.

This is a v1.2 cache layer for the spec §4.1 ``snapshots`` requirement —
it lets ``/monthly`` and ``/yearly`` close out N periods in O(N) hits to
this table instead of N full ledger roll-ups.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.repositories import snapshots_repo


def get_or_compute(session: Session, snapshot_date: date) -> Decimal:
    """Return the EUR portfolio value on ``snapshot_date``.

    If a stored snapshot exists for any historical date, return it.
    For ``date.today()`` the value is always recomputed live (today's
    prices are still moving) and the row is upserted in place.
    """
    # Lazy import to break the cycle (positions_service → repositories).
    from investment_dashboard.services import positions_service  # noqa: PLC0415

    today = date.today()
    if snapshot_date < today:
        existing = snapshots_repo.get_snapshot(session, snapshot_date)
        if existing is not None:
            return existing.total_value_eur

    value = positions_service.total_portfolio_value(session, as_of=snapshot_date)
    snapshots_repo.upsert_snapshot(session, snapshot_date, value)
    return value


def invalidate_from(session: Session, start: date) -> int:
    """Drop cached snapshots on/after ``start`` after a ledger mutation."""
    return snapshots_repo.delete_from(session, start)
