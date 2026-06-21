"""Price-history service — incremental refresh + last-known-price lookup."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.adapters.yfinance_client import (
    YFinanceError,
    fetch_closes,
    fetch_splits,
)
from investment_dashboard.models import Instrument
from investment_dashboard.repositories import (
    instrument_overrides_repo,
    instruments_repo,
    price_cache_repo,
    prices_repo,
    splits_repo,
)

log = logging.getLogger(__name__)


# TTLs by asset_class — controls how often the background refresh loop
# considers a symbol "due" for a fresh yfinance hit. ETFs/stocks are kept
# near-live so the user can watch intraday moves; mutual-fund NAVs only
# publish ~once a day; ``cash`` / ``savings`` rows are synthetic Savings
# balances with no yfinance ticker, so they get a sentinel large TTL.
REFRESH_TTL_SECONDS: dict[str, int] = {
    "etf": 2 * 60,
    "stock": 2 * 60,
    "mutual_fund": 6 * 60 * 60,
    "cash": 24 * 60 * 60,
    "savings": 24 * 60 * 60,
}
_DEFAULT_TTL_SECONDS = 24 * 60 * 60
# Asset classes that do not have a yfinance ticker.
_SYNTHETIC_ASSET_CLASSES = frozenset({"cash", "savings"})


def refresh_prices(
    session: Session,
    cache_session: Session | None = None,
    *,
    earliest_needed: date,
    today: date | None = None,
) -> dict[str, int]:
    """Backfill ``price_history`` for every active instrument.

    ``session`` reads the ledger tier (instruments + active overrides).
    ``cache_session`` writes the cache tier (``price_history`` and
    ``price_cache_metadata``). When unset, falls back to ``session`` —
    matches the legacy unified-DB call site and keeps tests passing
    without per-tier fixtures.

    Synthetic ``SAVINGS_CASH`` (and other ``cash``/``savings`` asset
    classes) is skipped — there is no yfinance ticker. Returns
    ``{symbol: rows_written}``.
    """
    cache = cache_session if cache_session is not None else session
    today = today or date.today()
    result: dict[str, int] = {}

    instruments = instruments_repo.list_instruments(session)
    inactive = instrument_overrides_repo.inactive_ids(session)
    symbols_to_fetch: list[str] = []
    earliest_per_symbol: dict[str, date] = {}
    for instr in instruments:
        if instr.asset_class in _SYNTHETIC_ASSET_CLASSES:
            continue
        if instr.id in inactive:
            continue
        latest = prices_repo.latest_price_date(cache, instr.id)
        earliest = prices_repo.earliest_price_date(cache, instr.id)
        if latest is None:
            start = earliest_needed
        elif earliest is not None and earliest > earliest_needed:
            # Leading gap: cached history starts later than the portfolio needs
            # (e.g. the first refresh ran before an older transaction existed,
            # or only extended forward). Refetch from ``earliest_needed`` to
            # fill the early dates; ``upsert_closes`` is idempotent so the
            # already-cached tail is rewritten harmlessly. Once filled,
            # ``earliest`` equals ``earliest_needed`` and the forward-only path
            # below takes over.
            start = earliest_needed
        else:
            start = max(earliest_needed, latest + timedelta(days=1))
        if start >= today + timedelta(days=1):
            result[instr.symbol] = 0
            continue
        symbols_to_fetch.append(instr.symbol)
        earliest_per_symbol[instr.symbol] = start

    if not symbols_to_fetch:
        return result

    start = min(earliest_per_symbol.values())
    end = today + timedelta(days=1)
    try:
        closes_by_symbol = fetch_closes(symbols_to_fetch, start, end)
    except YFinanceError as exc:
        log.warning("yfinance refresh failed (%s); continuing with stale prices", exc)
        return result

    by_symbol = {i.symbol: i for i in instruments}
    now = datetime.now(UTC).replace(tzinfo=None)
    for symbol, closes in closes_by_symbol.items():
        instr = by_symbol.get(symbol)
        if instr is None:
            continue
        cutoff = earliest_per_symbol.get(symbol, earliest_needed)
        filtered = {d: c for d, c in closes.items() if d >= cutoff}
        result[symbol] = prices_repo.upsert_closes(cache, instr.id, filtered)
        price_cache_repo.upsert_last_refreshed_at(cache, instr.id, now)
    return result


def refresh_splits(
    session: Session,
    cache_session: Session | None = None,
    *,
    earliest_needed: date,
    today: date | None = None,
) -> dict[str, int]:
    """Cache stock-split corporate actions for every active instrument.

    Splits are the authoritative basis for historical valuation: yfinance
    back-adjusts an instrument's whole price history by each split, including
    splits that occurred *after* the user sold the holding (which never appear
    as ledger ``split`` rows). Caching them lets historical valuations scale
    the share count on the same basis as the price for held *and* sold
    instruments.

    Fetches over the full ``[earliest_needed, today]`` window each call —
    splits are rare and the dataset is tiny, so a complete refetch is cheap and
    keeps the cache authoritative. ``upsert_splits`` is idempotent. Returns
    ``{symbol: rows_written}``.
    """
    cache = cache_session if cache_session is not None else session
    today = today or date.today()
    result: dict[str, int] = {}
    if earliest_needed >= today + timedelta(days=1):
        return result

    instruments = instruments_repo.list_instruments(session)
    inactive = instrument_overrides_repo.inactive_ids(session)
    symbols_to_fetch = [
        instr.symbol
        for instr in instruments
        if instr.asset_class not in _SYNTHETIC_ASSET_CLASSES and instr.id not in inactive
    ]
    if not symbols_to_fetch:
        return result

    end = today + timedelta(days=1)
    try:
        splits_by_symbol = fetch_splits(symbols_to_fetch, earliest_needed, end)
    except YFinanceError as exc:
        log.warning("yfinance split refresh failed (%s); keeping cached splits", exc)
        return result

    by_symbol = {i.symbol: i for i in instruments}
    for symbol, splits in splits_by_symbol.items():
        instr = by_symbol.get(symbol)
        if instr is None:
            continue
        result[symbol] = splits_repo.upsert_splits(cache, instr.id, splits)
    return result


def cumulative_split_factor_after(
    session: Session, instrument_id: int, as_of: date
) -> Decimal | None:
    """Feed-derived split factor for splits after ``as_of`` (cache tier).

    Returns the product of every cached split ratio dated after ``as_of`` so a
    pre-split valuation can scale the share count to the back-adjusted price.
    Returns ``None`` when *no* split data has been cached for the instrument —
    the signal for callers to fall back to the ledger ``split`` rows (the
    offline-safe path) rather than assume a unit factor. An instrument the feed
    confirms never split returns ``Decimal(1)``.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        if instrument_id not in splits_repo.instrument_ids_with_splits(cache, [instrument_id]):
            return None
        return splits_repo.cumulative_factor_after(cache, instrument_id, as_of)


def latest_close(session: Session, instrument_id: int) -> Decimal | None:
    """Last known close for ``instrument_id``.

    Reads from the cache tier: in split-DB mode prices live in a separate
    database that the caller's ledger session cannot see, so the lookup is
    routed through a cache-tier session (a no-op reuse in single-file mode).
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return prices_repo.latest_close(cache, instrument_id)


def close_as_of(session: Session, instrument_id: int, as_of: date) -> Decimal | None:
    """Most recent close for ``instrument_id`` on or before ``as_of``.

    Forward-fills sparse history so a historical valuation reflects the price
    that was actually in effect on ``as_of`` rather than today's close. Like
    :func:`latest_close`, the read is routed to the cache tier so split-DB
    installs see the prices written by the background refresh.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return prices_repo.close_as_of(cache, instrument_id, as_of)


def latest_closes(session: Session, instrument_ids: Sequence[int]) -> dict[int, Decimal]:
    """Batched :func:`latest_close` across ``instrument_ids`` (cache tier).

    One window query instead of a per-instrument lookup; instruments with no
    cached price are absent from the result (treat as ``None``).
    """
    if not instrument_ids:
        return {}
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return prices_repo.latest_closes(cache, instrument_ids)


def closes_as_of(
    session: Session, instrument_ids: Sequence[int], as_of: date
) -> dict[int, Decimal]:
    """Batched :func:`close_as_of` across ``instrument_ids`` (cache tier).

    Forward-filled most-recent close on or before ``as_of`` per instrument;
    instruments with no qualifying print are absent from the result.
    """
    if not instrument_ids:
        return {}
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return prices_repo.latest_closes(cache, instrument_ids, on_or_before=as_of)


def cumulative_split_factors_after(
    session: Session, instrument_ids: Sequence[int], as_of: date
) -> dict[int, Decimal]:
    """Batched :func:`cumulative_split_factor_after` (cache tier).

    Returns ``{instrument_id: factor}`` only for instruments that have cached
    split data; a missing key carries the same meaning as a ``None`` return
    from the singular helper (no feed data ⇒ fall back to ledger split rows).
    """
    if not instrument_ids:
        return {}
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return splits_repo.cumulative_factors_after(cache, instrument_ids, as_of)


def invalidate_instrument_prices(session: Session, instrument_id: int) -> int:
    """Drop an instrument's cached closes + refresh timestamp (cache tier).

    Called when an instrument's ticker is repointed at a different symbol so
    the stale closes for the old symbol can't keep forward-filling the new
    one. Returns the number of price rows removed.
    """
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415

    with cache_write_session(session) as cache:
        removed = prices_repo.delete_for_instrument(cache, instrument_id)
        price_cache_repo.delete_for_instrument(cache, instrument_id)
        splits_repo.delete_for_instrument(cache, instrument_id)
    return removed


def recent_price_dates(
    session: Session,
    instrument_ids: Sequence[int],
    *,
    on_or_before: date,
    limit: int = 2,
) -> list[date]:
    """Most recent distinct print dates across ``instrument_ids`` (cache tier).

    Tier-aware wrapper around :func:`prices_repo.recent_price_dates` so callers
    holding a ledger session still find the price history that lives in the
    cache database under split-DB layouts.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return prices_repo.recent_price_dates(
            cache, instrument_ids, on_or_before=on_or_before, limit=limit
        )


def instruments_with_price_anomalies(session: Session, instrument_ids: Sequence[int]) -> set[int]:
    """Instrument ids whose cached price history is corrupt (a non-positive close).

    Tier-aware wrapper around
    :func:`prices_repo.instrument_ids_with_nonpositive_close` so a caller
    holding a ledger session still inspects the price history that lives in the
    cache database under split-DB layouts. A returned id means the feed handed
    back a ``0`` (or negative) close at some point, which forward-fills into
    historical valuations and understates them — the UI flags it so the user
    knows that instrument's figures can't be trusted until it reprices.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return prices_repo.instrument_ids_with_nonpositive_close(cache, instrument_ids)


def _ttl_for(instr: Instrument) -> int:
    return REFRESH_TTL_SECONDS.get(instr.asset_class, _DEFAULT_TTL_SECONDS)


def instruments_due_for_refresh(
    session: Session,
    *,
    now: datetime | None = None,
) -> list[Instrument]:
    """Return the active, non-synthetic instruments whose cache TTL has expired.

    The background ``app.timer`` in :mod:`investment_dashboard.main` calls
    this every few minutes; whatever it returns is what we pull from
    yfinance — so the smaller this list, the cheaper the refresh.
    """
    now = now or datetime.now(UTC).replace(tzinfo=None)
    due: list[Instrument] = []
    inactive = instrument_overrides_repo.inactive_ids(session)
    for instr in instruments_repo.list_instruments(session):
        if instr.asset_class in _SYNTHETIC_ASSET_CLASSES:
            continue
        if instr.id in inactive:
            continue
        last = price_cache_repo.get_last_refreshed_at(session, instr.id)
        if last is None or (now - last).total_seconds() >= _ttl_for(instr):
            due.append(instr)
    return due


def refresh_due_prices(
    session: Session,
    *,
    today: date | None = None,
    now: datetime | None = None,
) -> dict[str, int]:
    """Refresh only the instruments whose per-asset-class TTL has expired.

    Returns ``{symbol: rows_written}``. Synthetic ``cash`` / ``savings``
    rows are never touched. yfinance errors are logged and absorbed so
    the live dashboard remains responsive.
    """
    today = today or date.today()
    now = now or datetime.now(UTC).replace(tzinfo=None)
    due = instruments_due_for_refresh(session, now=now)
    if not due:
        return {}

    symbols_to_fetch: list[str] = []
    earliest_per_symbol: dict[str, date] = {}
    for instr in due:
        latest = prices_repo.latest_price_date(session, instr.id)
        start = (latest + timedelta(days=1)) if latest is not None else today - timedelta(days=14)
        # Always fetch today's window so intraday closes overwrite stale rows.
        start = min(start, today)
        symbols_to_fetch.append(instr.symbol)
        earliest_per_symbol[instr.symbol] = start

    fetch_start = min(earliest_per_symbol.values())
    fetch_end = today + timedelta(days=1)
    try:
        closes_by_symbol = fetch_closes(symbols_to_fetch, fetch_start, fetch_end)
    except YFinanceError as exc:
        log.warning("yfinance live refresh failed (%s); continuing with stale prices", exc)
        return {}

    result: dict[str, int] = {}
    by_symbol = {i.symbol: i for i in due}
    for symbol, closes in closes_by_symbol.items():
        instr = by_symbol.get(symbol)
        if instr is None:
            continue
        cutoff = earliest_per_symbol.get(symbol, fetch_start)
        filtered = {d: c for d, c in closes.items() if d >= cutoff}
        result[symbol] = prices_repo.upsert_closes(session, instr.id, filtered)
        price_cache_repo.upsert_last_refreshed_at(session, instr.id, now)
    return result
