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

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.repositories import snapshots_repo


def get_or_compute(session: Session, snapshot_date: date) -> Decimal:
    """Return the EUR portfolio value on ``snapshot_date``.

    If a stored snapshot exists for any historical date, return it.
    For ``date.today()`` the value is always recomputed live (today's
    prices are still moving) and the row is upserted in place.

    Snapshots are cache-tier data. Under a split-DB layout they live in a
    separate database from the ledger the caller's ``session`` is bound to, so
    the cached row is read and written through cache-tier sessions while the
    live recomputation still rolls up transactions through the caller's ledger
    session. In single-file mode every tier shares one database and the
    caller's session is reused unchanged.
    """
    # Lazy import to break the cycle (positions_service → repositories).
    from investment_dashboard.db import cache_read_session, cache_write_session  # noqa: PLC0415
    from investment_dashboard.services import positions_service  # noqa: PLC0415

    today = date.today()
    if snapshot_date < today:
        with cache_read_session(session) as cache:
            existing = snapshots_repo.get_snapshot(cache, snapshot_date)
        if existing is not None:
            return existing.total_value_eur

    value = positions_service.total_portfolio_value(session, as_of=snapshot_date)
    with cache_write_session(session) as cache:
        snapshots_repo.upsert_snapshot(cache, snapshot_date, value)
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


def series_in_currency(
    session: Session,
    start: date,
    end: date,
    currency: str,
) -> list[tuple[date, Decimal]]:
    """Daily ``[start, end]`` portfolio values in ``currency``, computed in bulk.

    Batched equivalent of calling :func:`get_or_compute_in_currency` once per
    day. A naive day-by-day loop reopened a cache-tier session *and* reloaded
    the full FX rate series for every date in the range — 365+ cache sessions
    and 365+ full FX scans for the default one-year window, all on the request
    thread. This helper instead:

    * reads every already-cached snapshot in the window in a single query;
    * loads the EUR→``currency`` rate series once and forward-fills it in
      memory; and
    * only falls back to :func:`get_or_compute` for the days that are still
      missing from the cache (plus today, which is always recomputed live).

    The per-day values are identical to :func:`get_or_compute_in_currency`; only
    the number of round-trips changes.
    """
    currency = currency.upper()
    today = date.today()
    if end < start:
        return []

    # One bulk read of the already-cached historical snapshots.
    stored = stored_snapshots_in_range(session, start, end)

    # Load the FX rate series once instead of per day.
    rates: dict[date, Decimal] | None = None
    if currency != "EUR":
        from investment_dashboard.domain.currency import (  # noqa: PLC0415
            lookup_rate_with_forward_fill,
        )
        from investment_dashboard.services import fx_service  # noqa: PLC0415

        rates = fx_service.get_rates(session, base="EUR", quote=currency)

    out: list[tuple[date, Decimal]] = []
    day = start
    while day <= end:
        # Today is always recomputed live; a missing historical day is computed
        # and cached on demand exactly as the per-day helper would.
        eur = stored[day] if day < today and day in stored else get_or_compute(session, day)
        if currency == "EUR" or not rates:
            value = eur
        else:
            rate = lookup_rate_with_forward_fill(rates, day)
            value = eur if (rate is None or rate == 0) else eur * rate
        out.append((day, value))
        day += timedelta(days=1)
    return out


def warm_range(session: Session, start: date, end: date) -> int:
    """Compute and cache every snapshot in ``[start, end]`` (background use).

    The deferred network refresh drops the snapshot cache once fresh prices and
    FX land, so the *first* ``/overview`` or ``/analytics`` render would
    otherwise recompute the whole history day by day on the request thread —
    the slow first load (and occasional reconnect) the user sees. Warming the
    range from a background thread moves that work off the UI: the page then
    reads cached values. Best-effort and idempotent; returns the number of days
    actually (re)computed.

    Already-cached historical days are skipped after a single bulk read of the
    window instead of reopening a cache-tier session per day (B4); only the
    still-missing days — plus today, which always recomputes against live
    intra-day prices — fall through to :func:`get_or_compute`.
    """
    if end < start:
        return 0
    today = date.today()
    # One bulk read of the window instead of a per-day cache round-trip.
    stored = stored_snapshots_in_range(session, start, end)
    warmed = 0
    day = start
    while day <= end:
        # Historical days already cached need no recompute; today is always
        # recomputed because its intra-day price marks keep moving.
        if day < today and day in stored:
            day += timedelta(days=1)
            continue
        get_or_compute(session, day)
        warmed += 1
        day += timedelta(days=1)
    return warmed


def invalidate_from(session: Session, start: date) -> int:
    """Drop cached snapshots on/after ``start`` after a ledger mutation."""
    return snapshots_repo.delete_from(session, start)


def stored_snapshots_in_range(
    session: Session,
    start: date,
    end: date,
) -> dict[date, Decimal]:
    """Return ``{date: EUR value}`` for **already-stored** daily snapshots.

    Read-only: unlike :func:`get_or_compute` this never recomputes or
    caches missing days — it only surfaces the daily values that already
    exist so callers (period TWR chaining) can compound real intra-period
    sub-returns. Routed through the cache tier for split-DB layouts.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        rows = snapshots_repo.list_in_range(cache, start, end)
    return {r.snapshot_date: r.total_value_eur for r in rows}


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
