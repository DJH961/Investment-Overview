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

import logging
import threading
from collections.abc import Iterable
from datetime import date, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.domain.currency import usd_to_eur_at
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.repositories import snapshots_repo

log = logging.getLogger(__name__)

if TYPE_CHECKING:
    from investment_dashboard.models import PositionSnapshot


def snapshot_eur(row: PositionSnapshot) -> Decimal:
    """EUR value of a stored snapshot: ``usd / fx`` at its instant, else the EUR column."""
    if row.total_value_usd is not None and row.fx_eur_usd:
        return usd_to_eur_at(row.total_value_usd, row.fx_eur_usd)
    return row.total_value_eur


def get_or_compute(session: Session, snapshot_date: date, *, force: bool = False) -> Decimal:
    """Return the EUR portfolio value on ``snapshot_date``.

    If a stored snapshot exists for any historical date, return it.
    For ``exchange_today()`` the value is always recomputed live (today's
    prices are still moving) and the row is upserted in place.

    Pass ``force=True`` to ignore any cached historical value and recompute
    the day from scratch, upserting the fresh value in place. This is how the
    background refresh rebuilds the cache against newly-backfilled prices/FX
    *without* first deleting the old rows — readers keep seeing the previous
    (still-valid) value until the new one is written, so there is never an
    empty-cache window that would force an expensive full-history recompute
    onto the request thread.

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

    today = exchange_today()
    if snapshot_date < today and not force:
        with cache_read_session(session) as cache:
            existing = snapshots_repo.get_snapshot(cache, snapshot_date)
        if existing is not None:
            return snapshot_eur(existing)

    from investment_dashboard.services import fx_service  # noqa: PLC0415

    positions = positions_service.compute_positions(session, as_of=snapshot_date)
    value = positions_service.total_portfolio_value(
        session, as_of=snapshot_date, positions=positions
    )
    value_usd = positions_service.total_portfolio_value_usd(
        session, as_of=snapshot_date, positions=positions
    )
    fx = fx_service.get_rate_eur_to_quote(session, snapshot_date, quote="USD")
    with cache_write_session(session) as cache:
        snapshots_repo.upsert_snapshot(
            cache,
            snapshot_date,
            value,
            total_value_usd=value_usd if fx else None,
            fx_eur_usd=fx if fx else None,
        )
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
    if currency.upper() == "USD":
        # Stored native USD, never ``eur * rate``; today is recomputed (and stored) live.
        stored_usd = stored_usd_in_range(session, snapshot_date, snapshot_date).get(snapshot_date)
        if stored_usd is not None:
            return stored_usd
        return native_usd_on(session, snapshot_date)
    # Local import: fx_service → repositories → models; importing at
    # module load would pull the cache tier into every snapshot
    # consumer even when EUR-only.
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    rate = fx_service.get_rate_eur_to_quote(session, snapshot_date, quote=currency.upper())
    if rate is None or rate == 0:
        return eur
    return eur * rate


def native_usd_on(session: Session, snapshot_date: date, *, persist: bool = True) -> Decimal:
    """Native USD total on ``snapshot_date`` from the positions held then.

    USD holdings count at their own amount; only EUR-native ones convert. When a
    stored row for the day lacks its USD column (pre-0017) and a rate exists, the
    value is written back (EUR value untouched) so the next read is a lookup.
    """
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415
    from investment_dashboard.services import fx_service, positions_service  # noqa: PLC0415

    value = positions_service.total_portfolio_value_usd(session, as_of=snapshot_date)
    if persist and snapshot_date < exchange_today():
        fx = fx_service.get_rate_eur_to_quote(session, snapshot_date, quote="USD")
        if fx:
            with cache_write_session(session) as cache:
                snapshots_repo.fill_usd(cache, snapshot_date, value, fx)
    return value


def backfill_missing_usd(session: Session, *, limit: int = 200) -> int:
    """Fill the native USD total of up to ``limit`` snapshots that lack one (batch).

    Rows written before migration 0017 carry only the EUR value. Each is
    recomputed from the positions at its date (native, EUR column untouched).
    Returns the number of rows filled; ``0`` once none are left.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        missing = snapshots_repo.list_missing_usd(cache, limit)
    filled = 0
    today = exchange_today()
    for day in missing:
        if day >= today:
            continue  # today's row is always recomputed live
        before = stored_usd_in_range(session, day, day).get(day)
        if before is None:
            native_usd_on(session, day)
            if stored_usd_in_range(session, day, day).get(day) is not None:
                filled += 1
    return filled


def missing_usd_count(session: Session) -> int:
    """How many stored snapshots still lack a native USD total."""
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return len(snapshots_repo.list_missing_usd(cache, 1_000_000))


def get_or_compute_many(
    session: Session,
    dates: Iterable[date],
) -> dict[date, Decimal]:
    """Batched :func:`get_or_compute` for an arbitrary set of dates.

    The period pages need the closing/opening EUR value on each period
    boundary. Calling :func:`get_or_compute` once per boundary reopened a
    cache-tier session for every read even when the value was already
    cached. This helper instead bulk-reads every already-cached historical
    snapshot spanning the requested dates in a single query, and only falls
    back to :func:`get_or_compute` for the days that are still missing (plus
    today, which is always recomputed live). The per-date values are
    identical to calling :func:`get_or_compute` for each date.
    """
    wanted = sorted({d for d in dates})
    if not wanted:
        return {}
    today = exchange_today()
    historical = [d for d in wanted if d < today]
    stored: dict[date, Decimal] = {}
    if historical:
        stored = stored_snapshots_in_range(session, historical[0], historical[-1])
    out: dict[date, Decimal] = {}
    for d in wanted:
        if d < today and d in stored:
            out[d] = stored[d]
        else:
            out[d] = get_or_compute(session, d)
    return out


def series_in_currency(
    session: Session,
    start: date,
    end: date,
    currency: str,
    *,
    recompute_tail_days: int | None = None,
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

    ``recompute_tail_days`` bounds how much work this may push onto the request
    thread. When set, a historical day that is *not* already cached and is older
    than ``today - recompute_tail_days`` is **skipped** (omitted from the
    series) rather than recomputed synchronously — only today and the trailing
    ``recompute_tail_days`` days are ever computed live. The full-history Yearly
    chart uses this so it always renders from the persistent snapshot cache plus
    a few fresh recent days, never blocking the event loop on a cold full-history
    rebuild (the background warm fills in the rest, and a later render shows the
    complete curve). ``None`` (default) keeps the original recompute-every-day
    behaviour for callers that need a gap-free series.
    """
    currency = currency.upper()
    today = exchange_today()
    if end < start:
        return []

    # One bulk read of the already-cached historical snapshots.
    stored = stored_snapshots_in_range(session, start, end)
    # USD is read straight from the stored native-USD column (no FX round trip).
    stored_usd = stored_usd_in_range(session, start, end) if currency == "USD" else {}

    tail_floor = (
        today - timedelta(days=recompute_tail_days) if recompute_tail_days is not None else None
    )

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
        # and cached on demand exactly as the per-day helper would — unless a
        # tail budget is set and the day is older than it, in which case we skip
        # it to keep the request thread responsive (the background warm fills
        # the gap in for the next render).
        if day < today and day in stored:
            eur = stored[day]
        elif tail_floor is not None and day < today and day < tail_floor:
            day += timedelta(days=1)
            continue
        else:
            eur = get_or_compute(session, day)
        usd_native: Decimal | None = None
        if currency == "USD":
            usd_native = stored_usd.get(day) if day < today else None
            if usd_native is None:
                # Just computed (today / a missing day): ``get_or_compute`` stored it.
                usd_native = stored_usd_in_range(session, day, day).get(day)
        if currency == "USD" and usd_native is None:
            # A pre-0017 row (or one stored without a rate): compute the native
            # USD total from the positions on that day and persist it. Never
            # ``eur * rate``.
            usd_native = native_usd_on(session, day)
        if usd_native is not None:
            value = usd_native
        elif currency == "EUR" or not rates:
            value = eur
        else:
            rate = lookup_rate_with_forward_fill(rates, day)
            value = eur if (rate is None or rate == 0) else eur * rate
        out.append((day, value))
        day += timedelta(days=1)
    return out


def warm_range(session: Session, start: date, end: date, *, force: bool = False) -> int:
    """Compute and cache every snapshot in ``[start, end]`` (background use).

    The deferred network refresh rebuilds the snapshot cache once fresh prices
    and FX land, so the *first* ``/overview``, ``/analytics`` or ``/yearly``
    render would otherwise recompute the whole history day by day on the
    request thread — the slow first load (and the reconnect/"crash" the user
    sees when opening the daily-granularity Yearly chart). Warming the range
    from a background thread moves that work off the UI: the page then reads
    cached values. Best-effort and idempotent; returns the number of days
    actually (re)computed.

    With ``force=False`` (default) already-cached historical days are skipped
    after a single bulk read of the window; only the still-missing days — plus
    today, which always recomputes against live intra-day prices — fall through
    to :func:`get_or_compute`.

    With ``force=True`` every historical day is recomputed and upserted in
    place, overwriting values that were cached against an empty/partial
    price + FX cache (e.g. the ``0`` closing values persisted by a render that
    ran before the backfill landed). Because the rows are overwritten rather
    than deleted first, readers never observe an empty cache mid-rebuild, so a
    full-history page like Yearly is never pushed into a synchronous cold
    recompute on the request thread.
    """
    if end < start:
        return 0
    today = exchange_today()
    if force:
        # A forced rebuild means a close (or rate) moved: the per-holding daily
        # values from ``start`` on go too and rebuild lazily on their next read.
        _drop_holding_values_from(session, start)
    # One bulk read of the window instead of a per-day cache round-trip.
    stored = stored_snapshots_in_range(session, start, end)
    warmed = 0
    day = start
    while day <= end:
        # Historical days already cached need no recompute unless we are
        # force-rebuilding; today is always recomputed because its intra-day
        # price marks keep moving.
        if not force and day < today and day in stored:
            day += timedelta(days=1)
            continue
        get_or_compute(session, day, force=force)
        warmed += 1
        day += timedelta(days=1)
    return warmed


_fill_lock = threading.Lock()
_fill_running = False


def fill_missing_in_background(start: date, end: date) -> bool:
    """Compute the uncached days in ``[start, end]`` on a background thread.

    A bounded read (``series_in_currency(..., recompute_tail_days=N)``) leaves out
    uncached days older than its tail, so after an import or edit of past trades
    (which drops every cached snapshot from that date on) the Risk curve silently
    lost those days until the evening job warmed the cache again. The reader calls
    this; once the days are stored a ``refresh`` event makes open pages re-read.
    Single flight: returns ``False`` when a fill is already running. Best-effort.
    """
    global _fill_running  # noqa: PLW0603
    with _fill_lock:
        if _fill_running:
            return False
        _fill_running = True

    def run() -> None:
        global _fill_running  # noqa: PLW0603
        try:
            from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
            from investment_dashboard.services import refresh_status  # noqa: PLC0415

            with ledger_session_scope() as session:
                warmed = warm_range(session, start, end)
            activity("system").info(
                "filled %d missing daily snapshot(s) from %s to %s", warmed, start, end
            )
            if warmed:
                refresh_status._publish({"type": "refresh", "reason": "snapshots filled"})
        except Exception:  # pragma: no cover - best-effort, the evening job retries
            log.warning("background snapshot fill failed", exc_info=True)
        finally:
            with _fill_lock:
                _fill_running = False

    try:
        threading.Thread(target=run, name="inv-snapshot-fill", daemon=True).start()
    except Exception:  # pragma: no cover - thread creation failure
        with _fill_lock:
            _fill_running = False
        return False
    return True


def _drop_holding_values_from(session: Session, start: date) -> None:
    """Drop every holding's daily values from ``start`` (price / FX / split change)."""
    from investment_dashboard.services import holding_values_service  # noqa: PLC0415

    try:
        holding_values_service.invalidate_from(session, start)
    except Exception:  # pragma: no cover - defensive: snapshot invalidation must not break
        log.warning("could not drop the holding daily values", exc_info=True)


def invalidate_from(session: Session, start: date) -> int:
    """Drop cached snapshots on/after ``start`` after a price / FX / split change.

    The per-holding daily values go from the same date. A trade invalidates through
    :func:`invalidate_for_trade_dates` instead, which leaves the other holdings'
    values alone (their callers drop the traded instrument's rows).
    """
    _drop_holding_values_from(session, start)
    return snapshots_repo.delete_from(session, start)


def invalidate_for_trade_dates(
    session: Session,
    dates: Iterable[date],
    *,
    today: date | None = None,
) -> int:
    """Drop cached snapshots from the earliest affected *past* trade date on.

    Call this whenever a transaction is inserted, updated, or deleted with a
    ``date`` in the past: every cached daily close on or after that date is now
    stale (the ledger roll-up behind it changed), so dropping those rows lets
    ``/monthly``, ``/yearly`` and the equity curve recompute the affected window
    lazily on next read. Dates equal to (or after) ``today`` are ignored —
    today's snapshot is always recomputed live, so it never needs clearing.

    Routes through the cache-tier write session so it works under split-DB
    layouts. Returns the number of snapshots dropped (``0`` if nothing was in
    the past, e.g. a brand-new same-day entry).
    """
    today = today or exchange_today()
    past = [d for d in dates if d < today]
    if not past:
        return 0
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415

    with cache_write_session(session) as cache:
        return snapshots_repo.delete_from(cache, min(past))


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
    return {r.snapshot_date: snapshot_eur(r) for r in rows}


def stored_usd_in_range(
    session: Session,
    start: date,
    end: date,
) -> dict[date, Decimal]:
    """Return ``{date: native USD value}`` for stored snapshots that carry one.

    The USD graph/series reads these directly (FX-free); rebuilding USD as
    ``usd_stored x ECB / fx_stored`` would drift with rate revisions.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        rows = snapshots_repo.list_in_range(cache, start, end)
    return {
        r.snapshot_date: r.total_value_usd
        for r in rows
        if r.total_value_usd is not None and r.fx_eur_usd
    }


def invalidate_all(session: Session) -> int:
    """Drop every cached snapshot so they recompute from current data.

    The web UI opens *before* the deferred FX/price backfill finishes, so
    the first render of ``/monthly`` or ``/yearly`` computes every period's
    closing value against an empty (or partial) price + FX cache and persists
    those as ``0``. Nothing in the periodic refresh path invalidated those
    rows, so the zero closing values stuck permanently. Clearing the whole
    snapshot cache after a backfill forces the next render to recompute each
    period with the now-complete price + FX history. Snapshots are pure
    cache-tier data (regenerable), so dropping them is always safe. The per-holding
    daily values go too.
    """
    _drop_holding_values_from(session, date.min)
    return snapshots_repo.delete_from(session, date.min)
