"""Snapshots service — read-through cache for daily portfolio EUR value.

Today's snapshot is always recomputed (intra-day prices keep moving);
historical snapshots are computed once and reused.

This is a v1.2 cache layer for the spec §4.1 ``snapshots`` requirement —
it lets ``/monthly`` and ``/yearly`` close out N periods in O(N) hits to
this table instead of N full ledger roll-ups.

v2.2 added :func:`get_or_compute_in_currency` which converts the cached
EUR value into the display currency using the FX rate **on the snapshot
date** (forward-filled to the most recent prior business day). The
historical equity curve therefore reflects historical FX swings instead
of being a uniform scalar of today's spot rate.
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


def get_or_compute_in_currency(
    session: Session,
    snapshot_date: date,
    currency: str,
) -> Decimal:
    """EUR snapshot for ``snapshot_date`` converted into ``currency``.

    Conversion uses the EUR→``currency`` rate **on the snapshot date**
    (forward-filled per :func:`investment_dashboard.domain.currency.
    lookup_rate_with_forward_fill`), so a historical USD/DKK equity
    curve responds to FX swings rather than being today's spot scalar
    applied uniformly across history. Returns the raw EUR value when
    ``currency == 'EUR'`` or when no FX rate is available (degrade
    gracefully — spec §5.6).
    """
    eur = get_or_compute(session, snapshot_date)
    if currency.upper() == "EUR":
        return eur
    # Local import: fx_service → repositories → models; importing at
    # module load would pull the cache tier into every snapshot
    # consumer even when EUR-only.
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    rate = fx_service.get_rate_eur_to_quote(session, snapshot_date, quote=currency.upper())
    if rate is None or rate == 0:
        return eur
    return eur * rate


def invalidate_from(session: Session, start: date) -> int:
    """Drop cached snapshots on/after ``start`` after a ledger mutation."""
    return snapshots_repo.delete_from(session, start)


def invalidate_all(session: Session) -> int:
    """Drop every cached snapshot so they recompute from current data.

    The web UI opens *before* the deferred FX/price backfill finishes, so
    the first render of ``/monthly`` or ``/yearly`` computes every period's
    closing value against an empty (or partial) price + FX cache and persists
    those as ``0``. Nothing in the periodic refresh path invalidated those
    rows, so the zero closing values stuck permanently. Clearing the whole
    snapshot cache after a backfill forces the next render to recompute each
    period with the now-complete price + FX history. Snapshots are pure
    cache-tier data (regenerable), so dropping them is always safe.
    """
    return snapshots_repo.delete_from(session, date.min)
