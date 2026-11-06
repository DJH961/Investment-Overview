"""Price-history service — incremental refresh + last-known-price lookup."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy.orm import Session

from investment_dashboard.adapters.yfinance_client import (
    YFinanceError,
    fetch_closes,
    fetch_market_times,
    fetch_splits,
)
from investment_dashboard.domain.instruments import (
    NAV_ASSET_CLASSES,
    SYNTHETIC_ASSET_CLASSES,
    fetch_symbol,
)
from investment_dashboard.domain.market_hours import (
    exchange_today,
    is_us_market_open,
    latest_settled_session_date,
)
from investment_dashboard.repositories import (
    instrument_overrides_repo,
    instruments_repo,
    price_cache_repo,
    prices_repo,
    splits_repo,
)
from investment_dashboard.services import fetch_report, pull_log

if TYPE_CHECKING:
    from investment_dashboard.models import Instrument

log = logging.getLogger(__name__)


def _fetch_rules(session: Session) -> tuple[set[int], dict[int, str]]:
    """``(skip_ids, provider_symbols)`` from the instrument settings (config tier).

    ``skip_ids`` are never sent to a provider: inactive instruments and those
    whose pricing mode is ``manual`` or ``delisted`` (their last close keeps
    valuing them). ``provider_symbols`` maps an instrument id to the ticker the
    provider knows it by, when that differs from the ledger symbol.
    """
    return (
        instrument_overrides_repo.not_fetched_ids(session),
        instrument_overrides_repo.provider_symbol_map(session),
    )


def _resolve_tiingo_token() -> str | None:
    """Resolve the Tiingo token: in-app setting > env > the OS keyring.

    The in-app value (``tiingo.api_token``, write-only, encrypted config tier)
    falls back to ``INV_DASHBOARD_TIINGO_TOKEN`` inside ``settings_service``.
    Returns ``None`` when no token is configured, which cleanly disables the
    fallback (a vanilla install never touches Tiingo).
    """
    from investment_dashboard.config import get_settings  # noqa: PLC0415
    from investment_dashboard.services import settings_service  # noqa: PLC0415
    from investment_dashboard.storage.encryption import (  # noqa: PLC0415
        load_tiingo_token_from_keyring,
    )

    try:
        token = settings_service.get("tiingo.api_token")
    except Exception:
        token = None
    if isinstance(token, str) and token:
        return token
    return get_settings().tiingo_token or load_tiingo_token_from_keyring()


# TTLs by asset_class — controls how often the background refresh loop
# considers a symbol "due" for a fresh yfinance hit. ETFs/stocks are kept
# near-live so the user can watch intraday moves; mutual-fund NAVs only
# publish ~once a day; ``cash`` / ``savings`` rows are synthetic Savings
# balances with no yfinance ticker, so they get a sentinel large TTL.
REFRESH_TTL_SECONDS: dict[str, int] = {
    "etf": 50,
    "stock": 50,
    "mutual_fund": 10 * 60,
    "cash": 24 * 60 * 60,
    "savings": 24 * 60 * 60,
}
_DEFAULT_TTL_SECONDS = 24 * 60 * 60
# Asset classes that do not have a yfinance ticker.
_SYNTHETIC_ASSET_CLASSES = SYNTHETIC_ASSET_CLASSES
# Asset classes priced off a once-a-day NAV (published after the close) rather
# than an intraday exchange quote. Mirrors the Tiingo fallback wiring's NAV set
# and the browser companion's fetchable-NAV classes.
_NAV_ASSET_CLASSES = NAV_ASSET_CLASSES


def _force_refresh_window(
    *,
    asset_class: str,
    latest: date | None,
    earliest: date | None,
    earliest_needed: date,
    today: date,
    settled: date,
    market_open: bool,
) -> tuple[date, date]:
    """Return the ``(start, anchor)`` fetch window for one holding's force refresh.

    ``start`` is the first date to fetch: forward-only from the cached tail
    normally, or back to ``earliest_needed`` when the cache is empty or has a
    leading gap (cached history begins later than the portfolio needs). It is
    then clamped to the holding's *anchor* — the most recent date the holding
    can actually be priced, so a manual re-pull always double-checks the latest
    value without asking yfinance for a window that can only come back empty (a
    "no data" Data Health warning). The anchor is today's live intraday quote
    for market holdings while the session is open, otherwise the latest settled
    close; NAV funds publish once a day after the bell, so they always anchor to
    the latest settled session's NAV and are never asked for an intraday window.
    Clamping to the anchor guarantees the batched request covers a real trading
    session. The desktop's yfinance primary is unmetered, so this broad re-pull
    is free.
    """
    if latest is None or (earliest is not None and earliest > earliest_needed):
        start = earliest_needed
    else:
        start = max(earliest_needed, latest + timedelta(days=1))
    # NAV funds price off a once-a-day close (never an intraday "today"); market
    # holdings take today's live quote while open, else the latest settled close.
    anchor = settled if asset_class in _NAV_ASSET_CLASSES else (today if market_open else settled)
    return min(start, anchor), anchor


def _report_suspect_data(
    cache: Session,
    by_symbol: dict[str, Instrument],
    written_ids: Sequence[int],
    round_: pull_log.PullRound,
) -> None:
    """Flag any just-written instrument whose cached close is non-positive.

    A ``0``/negative close is the classic "feed handed back garbage" failure —
    it forward-fills into valuations and silently understates them. Surfacing it
    in the pull narrative answers the user's "what generated wrong data?" without
    waiting for the Data Health page to notice. Best-effort: a lookup failure
    never disturbs the refresh itself.
    """
    if not written_ids:
        return
    try:
        suspect_ids = instruments_with_price_anomalies(cache, list(written_ids))
    except Exception:  # pragma: no cover - defensive: never break the refresh
        return
    if not suspect_ids:
        return
    id_to_symbol = {instr.id: sym for sym, instr in by_symbol.items()}
    round_.suspect_data("yfinance", [id_to_symbol[i] for i in suspect_ids if i in id_to_symbol])


def provider_symbols_for(session: Session, symbols: Iterable[str]) -> dict[str, str | None]:
    """``{ledger symbol: provider ticker}`` for ``symbols``.

    The value is ``None`` for an instrument the provider must not be asked
    about (inactive, or pricing mode ``manual`` / ``delisted``). A symbol with
    no instrument row maps to itself.
    """
    wanted = set(symbols)
    out: dict[str, str | None] = {sym: sym for sym in wanted}
    skip, provider_symbols = _fetch_rules(session)
    for instr in instruments_repo.list_instruments(session):
        if instr.symbol in wanted:
            out[instr.symbol] = (
                None
                if instr.id in skip
                else fetch_symbol(instr.symbol, provider_symbols.get(instr.id))
            )
    return out


def via_provider_symbols(session: Session, fetch: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap a symbol-batch fetch (first argument: the symbols) for the instrument
    mapping: it asks the provider for the mapped tickers, skips not-fetched
    instruments, and answers keyed by ledger symbol again."""

    def wrapped(symbols: Sequence[str], *args: Any, **kwargs: Any) -> dict[str, Any]:
        mapping = provider_symbols_for(session, symbols)
        wanted = {ledger: prov for ledger, prov in mapping.items() if prov is not None}
        if not wanted:
            return {}
        if all(ledger == prov for ledger, prov in wanted.items()) and len(wanted) == len(mapping):
            return dict(fetch(symbols, *args, **kwargs))
        raw = fetch(sorted(set(wanted.values())), *args, **kwargs)
        return {ledger: raw[prov] for ledger, prov in wanted.items() if prov in raw}

    return wrapped


def refresh_prices(  # noqa: PLR0915 - one cohesive pull round, narrated start to end
    session: Session,
    cache_session: Session | None = None,
    *,
    earliest_needed: date,
    today: date | None = None,
    now: datetime | None = None,
    source: str | None = None,
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

    The fetch window's tail is *anchored* to the most recent date each
    holding can actually have a price, so a manual re-pull double-checks
    the latest close/NAV without ever asking yfinance for a window that can
    only come back empty (which would surface a "no data" Data Health
    warning). Market holdings anchor to today while the session is open
    (live intraday) and otherwise to the latest settled close; NAV funds
    never have an intraday value, so they always anchor to the latest
    settled session's published NAV.
    """
    cache = cache_session if cache_session is not None else session
    today = today or exchange_today()
    now = now or datetime.now(UTC).replace(tzinfo=None)
    now_utc = now if now.tzinfo is not None else now.replace(tzinfo=UTC)
    market_open = is_us_market_open(now_utc)
    settled = latest_settled_session_date(now_utc)
    result: dict[str, int] = {}

    round_ = pull_log.current()
    owns_round = round_ is None
    if owns_round:
        round_ = pull_log.begin(source or "Price re-pull", mode="full re-pull (recent window)")
    try:
        instruments = instruments_repo.list_instruments(session)
        inactive, provider_symbols = _fetch_rules(session)
        # Batch the per-instrument MAX/MIN(date) lookups into two GROUP BY queries
        # instead of 2N individual round-trips.
        candidate_ids = [
            instr.id
            for instr in instruments
            if instr.asset_class not in _SYNTHETIC_ASSET_CLASSES and instr.id not in inactive
        ]
        latest_dates = prices_repo.latest_price_dates(cache, candidate_ids)
        earliest_dates = prices_repo.earliest_price_dates(cache, candidate_ids)
        symbols_to_fetch: list[str] = []
        earliest_per_symbol: dict[str, date] = {}
        anchors: list[date] = []
        targets: list[Instrument] = []
        for instr in instruments:
            if instr.asset_class in _SYNTHETIC_ASSET_CLASSES:
                continue
            if instr.id in inactive:
                continue
            start, anchor = _force_refresh_window(
                asset_class=instr.asset_class,
                latest=latest_dates.get(instr.id),
                earliest=earliest_dates.get(instr.id),
                earliest_needed=earliest_needed,
                today=today,
                settled=settled,
                market_open=market_open,
            )
            sym = fetch_symbol(instr.symbol, provider_symbols.get(instr.id))
            symbols_to_fetch.append(sym)
            earliest_per_symbol[sym] = start
            anchors.append(anchor)
            targets.append(instr)

        if not symbols_to_fetch:
            round_.note(
                f"nothing to pull ({len(instruments)} instrument(s), "
                "all synthetic/inactive/current)"
            )
            return result

        start = min(earliest_per_symbol.values())
        end = max(anchors) + timedelta(days=1)
        round_.requested_window(
            "yfinance",
            symbols_to_fetch,
            start,
            end,
            detail=f"market_open={market_open}, settled={settled}",
        )
        try:
            closes_by_symbol = fetch_closes(symbols_to_fetch, start, end)
        except YFinanceError as exc:
            round_.provider_failed("yfinance", f"{exc}; continuing with stale prices")
            return result
        # Note which tickers we just asked yfinance for, so Settings can report it.
        fetch_report.record("yfinance", symbols_to_fetch)

        by_symbol = {i.symbol: i for i in instruments}
        now = datetime.now(UTC).replace(tzinfo=None)
        # Stamp *when each price is from* too (the provider's market time), as the
        # live tick does: without it a manual re-pull (Fix -> Update prices) left
        # the "prices as of" time where it was, so it looked as if nothing updated.
        try:
            market_times = fetch_market_times(symbols_to_fetch) if closes_by_symbol else {}
        except Exception:  # pragma: no cover - defensive: never break the refresh
            log.debug("market-time capture failed; continuing without it", exc_info=True)
            market_times = {}
        fetch_syms = {
            instr.id: fetch_symbol(instr.symbol, provider_symbols.get(instr.id))
            for instr in targets
        }
        if _observe_feed(
            session, targets, fetch_syms, closes_by_symbol, market_times, now=now, today=today
        ):
            round_.note("price feed stalled: quotes unchanged / old market time")
        written_ids: list[int] = []
        for instr in targets:
            sym = fetch_symbol(instr.symbol, provider_symbols.get(instr.id))
            closes = closes_by_symbol.get(sym, {})
            cutoff = earliest_per_symbol.get(sym, earliest_needed)
            filtered = {d: c for d, c in closes.items() if d >= cutoff}
            result[instr.symbol] = prices_repo.upsert_closes(cache, instr.id, filtered)
            if result[instr.symbol]:
                written_ids.append(instr.id)
            # Stamp every instrument we queried (see refresh_due_prices) so the
            # overview's per-symbol "updated" time advances even when the feed
            # returned nothing new for that symbol.
            price_cache_repo.upsert_last_refreshed_at(
                cache, instr.id, now, market_time=market_times.get(sym)
            )
        round_.settled("yfinance", result)
        _report_suspect_data(cache, by_symbol, written_ids, round_)
        return result
    finally:
        if owns_round:
            pull_log.end(round_)


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
    today = today or exchange_today()
    result: dict[str, int] = {}
    if earliest_needed >= today + timedelta(days=1):
        return result

    instruments = instruments_repo.list_instruments(session)
    inactive, provider_symbols = _fetch_rules(session)
    # provider ticker -> instrument (the mapping, else the ledger symbol)
    by_fetch_symbol = {
        fetch_symbol(instr.symbol, provider_symbols.get(instr.id)): instr
        for instr in instruments
        if instr.asset_class not in _SYNTHETIC_ASSET_CLASSES and instr.id not in inactive
    }
    symbols_to_fetch = list(by_fetch_symbol)
    if not symbols_to_fetch:
        return result

    end = today + timedelta(days=1)
    try:
        splits_by_symbol = fetch_splits(symbols_to_fetch, earliest_needed, end)
    except YFinanceError as exc:
        log.warning("yfinance split refresh failed (%s); keeping cached splits", exc)
        return result

    for symbol, splits in splits_by_symbol.items():
        instr = by_fetch_symbol.get(symbol)
        if instr is None:
            continue
        result[instr.symbol] = splits_repo.upsert_splits(cache, instr.id, splits)
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


def cumulative_split_factors_after(
    session: Session, instrument_ids: Sequence[int], as_of: date
) -> dict[int, Decimal]:
    """Batched :func:`cumulative_split_factor_after` (cache tier).

    Returns ``{instrument_id: factor}`` only for instruments that have cached
    split data; an instrument absent from the mapping carries the same "no
    split data cached — fall back to the ledger ``split`` rows" signal that the
    per-instrument helper conveys with ``None``.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return splits_repo.cumulative_factors_after(cache, instrument_ids, as_of)


def latest_close(session: Session, instrument_id: int) -> Decimal | None:
    """Last known close for ``instrument_id``.

    Reads from the cache tier: in split-DB mode prices live in a separate
    database that the caller's ledger session cannot see, so the lookup is
    routed through a cache-tier session (a no-op reuse in single-file mode).
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return prices_repo.latest_close(cache, instrument_id)


def closes_for_instrument(session: Session, instrument_id: int) -> dict[date, Decimal]:
    """Every stored close for ``instrument_id`` (cache tier)."""
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return prices_repo.get_closes_for_instrument(cache, instrument_id)


def store_closes(
    session: Session, instrument_id: int, closes: dict[date, Decimal], *, source: str
) -> int:
    """Upsert ``closes`` for ``instrument_id`` into the cache tier; returns rows written."""
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415

    with cache_write_session(session) as cache:
        return prices_repo.upsert_closes(cache, instrument_id, closes, source=source)


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


def latest_price_dates_for(session: Session, instrument_ids: Sequence[int]) -> dict[int, date]:
    """Newest cached print *date* per instrument (cache tier).

    Tier-aware wrapper around :func:`prices_repo.latest_price_dates`. This is
    the price's observation date — the "as of" the desktop holding cards show
    so a stale-but-latest close reads honestly (mirroring the web companion's
    per-row "as of" chip). Instruments with no cached history are absent.
    """
    if not instrument_ids:
        return {}
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return prices_repo.latest_price_dates(cache, instrument_ids)


def last_refreshed_at_for(session: Session, instrument_ids: Sequence[int]) -> dict[int, datetime]:
    """When each instrument's price cache was last refreshed (cache tier).

    Tier-aware wrapper around :func:`price_cache_repo.get_last_refreshed_at_map`
    — the saved timestamp the background loop stamps every time it pulls fresh
    prices, surfaced so the desktop can show *when the price was last updated*.
    Instruments never refreshed are absent from the mapping.
    """
    if not instrument_ids:
        return {}
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return price_cache_repo.get_last_refreshed_at_map(cache, instrument_ids)


def market_time_for(session: Session, instrument_ids: Sequence[int]) -> dict[int, datetime]:
    """When each instrument's served price is *from* on the exchange (cache tier).

    Tier-aware wrapper around :func:`price_cache_repo.get_market_time_map` — the
    provider's ``regularMarketTime`` the live refresh stamps alongside the pull
    time, surfaced so the desktop can date a settled-today figure by *when the
    price is from* (e.g. a mutual fund's NAV publish time) rather than when we
    happened to fetch it. Instruments without a recorded market time are absent.
    """
    if not instrument_ids:
        return {}
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return price_cache_repo.get_market_time_map(cache, instrument_ids)


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


def invalidate_instrument_prices(
    session: Session, instrument_id: int, *, keep_manual: bool = False
) -> int:
    """Drop an instrument's cached closes + refresh timestamp (cache tier).

    Called when an instrument's ticker is repointed at a different symbol so
    the stale closes for the old symbol can't keep forward-filling the new
    one (everything goes), and by the "Re-download prices" repair
    (``keep_manual=True``: hand-entered closes and splits stay). Returns the
    number of price rows removed.
    """
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415

    with cache_write_session(session) as cache:
        removed = prices_repo.delete_for_instrument(cache, instrument_id, keep_manual=keep_manual)
        price_cache_repo.delete_for_instrument(cache, instrument_id)
        splits_repo.delete_for_instrument(cache, instrument_id, keep_manual=keep_manual)
    return removed


def recent_closes_by_instrument(
    session: Session,
    instrument_ids: Sequence[int],
    *,
    on_or_before: date,
    limit: int = 2,
) -> dict[int, list[tuple[date, Decimal]]]:
    """Batched per-instrument ``(date, close)`` lookup (cache tier).

    Tier-aware wrapper around :func:`prices_repo.recent_closes_by_instrument`
    so a caller holding a ledger session still reads the price history that
    lives in the cache database under split-DB layouts.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    with cache_read_session(session) as cache:
        return prices_repo.recent_closes_by_instrument(
            cache, instrument_ids, on_or_before=on_or_before, limit=limit
        )


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


def ttl_seconds_by_class(session: Session | None = None) -> dict[str, int]:
    """Effective price TTLs per asset class (settings ``prices.ttl_seconds.*``).

    Keys are the asset classes plus ``"default"``; the module constants are the
    defaults and the fallback when settings cannot be read.
    """
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    out = {**REFRESH_TTL_SECONDS, "default": _DEFAULT_TTL_SECONDS}
    try:
        values = settings_service.get_all(session)
    except Exception:
        return out
    for cls in out:
        eff = values.get(f"prices.ttl_seconds.{cls}")
        if eff is not None and eff.source != "default" and isinstance(eff.value, int):
            out[cls] = eff.value
    return out


def _ttl_for(instr: Instrument, ttls: dict[str, int] | None = None) -> int:
    ttls = ttls if ttls is not None else {**REFRESH_TTL_SECONDS, "default": _DEFAULT_TTL_SECONDS}
    return ttls.get(instr.asset_class, ttls["default"])


def _is_due_for_market_state(
    instr: Instrument,
    latest_date: date | None,
    *,
    market_open: bool,
    settled_date: date,
) -> bool:
    """Whether ``instr`` is worth polling given the market clock and what's cached.

    Mirrors the browser companion's update policy so the background refresh stops
    hammering yfinance for data that cannot have changed:

    * NAV funds (mutual funds) publish once a day after the close, so they are
      due only while we don't yet hold the latest settled session's NAV — never
      intraday.
    * Market symbols (ETFs / stocks / tickered holdings) are due live while the
      session is open, and once after the bell to capture the official settled
      close; once that close is cached they're skipped until the next session, so
      there are no pointless overnight, weekend or pre-open fetches.

    A symbol with nothing cached (``latest_date is None``) is always due so a
    brand-new holding — or one whose TTL lapsed before its first successful pull
    — gets fetched immediately.
    """
    if latest_date is None:
        return True
    if instr.asset_class in _NAV_ASSET_CLASSES:
        return latest_date < settled_date
    if market_open:
        return True
    return latest_date < settled_date


def instruments_due_for_refresh(
    session: Session,
    cache_session: Session | None = None,
    *,
    now: datetime | None = None,
) -> list[Instrument]:
    """Return the active, non-synthetic instruments worth pulling right now.

    The background ``app.timer`` in :mod:`investment_dashboard.main` calls
    this every few minutes; whatever it returns is what we pull from
    yfinance — so the smaller this list, the cheaper the refresh.

    An instrument is due only when **both** gates pass: its per-asset-class TTL
    has expired *and* the market clock says fresh data could exist (see
    :func:`_is_due_for_market_state`). The second gate stops the loop from
    re-fetching closed-market symbols every tick (which made yfinance log a
    "no data" warning overnight and weekends and churned the event loop); manual
    refreshes go through :func:`refresh_prices`, which ignores both gates and
    always pulls, so a user can still force an update at any time.

    ``session`` reads the ledger tier (instruments + active overrides);
    ``cache_session`` reads the cache tier (``price_cache_metadata`` and
    ``price_history``). When unset it falls back to ``session`` (single-file
    layout). In split-DB mode the last-refresh timestamps and cached closes live
    in the cache database, so reading them through the ledger session would
    always come back empty and mark *every* instrument due on every tick.
    """
    cache = cache_session if cache_session is not None else session
    now = now or datetime.now(UTC).replace(tzinfo=None)
    # The market-clock helpers read a naive datetime as already-exchange-time, so
    # tag our naive-UTC ``now`` as UTC before handing it over.
    now_utc = now if now.tzinfo is not None else now.replace(tzinfo=UTC)
    market_open = is_us_market_open(now_utc)
    settled_date = latest_settled_session_date(now_utc)
    due: list[Instrument] = []
    inactive = instrument_overrides_repo.not_fetched_ids(session)
    instruments = instruments_repo.list_instruments(session)
    ids = [i.id for i in instruments]
    # One IN(...) query each for the last-refresh timestamps and newest cached
    # print dates instead of one lookup per instrument.
    last_refreshed = price_cache_repo.get_last_refreshed_at_map(cache, ids)
    latest_dates = prices_repo.latest_price_dates(cache, ids)
    ttls = ttl_seconds_by_class(session)
    for instr in instruments:
        if instr.asset_class in _SYNTHETIC_ASSET_CLASSES:
            continue
        if instr.id in inactive:
            continue
        last = last_refreshed.get(instr.id)
        if last is not None and (now - last).total_seconds() < _ttl_for(instr, ttls):
            continue
        if not _is_due_for_market_state(
            instr,
            latest_dates.get(instr.id),
            market_open=market_open,
            settled_date=settled_date,
        ):
            continue
        due.append(instr)
    return due


def refresh_due_prices(  # noqa: PLR0912, PLR0915 - one cohesive pull round, narrated start to end
    session: Session,
    cache_session: Session | None = None,
    *,
    today: date | None = None,
    now: datetime | None = None,
    source: str | None = None,
) -> dict[str, int]:
    """Refresh only the instruments whose per-asset-class TTL has expired.

    ``session`` reads the ledger tier (instruments + active overrides);
    ``cache_session`` reads **and writes** the cache tier (``price_history``
    and ``price_cache_metadata``). When unset it falls back to ``session``
    (single-file layout). In split-DB mode the cached closes and last-refresh
    stamps live in a separate database that the overview reads through the
    cache tier — writing them through the ledger session would land them in the
    wrong database, so the per-symbol "updated" time (and prices) would never
    advance from the live tick even though the fetch succeeded.

    Returns ``{symbol: rows_written}``. Synthetic ``cash`` / ``savings``
    rows are never touched. yfinance errors are logged and absorbed so
    the live dashboard remains responsive.
    """
    cache = cache_session if cache_session is not None else session
    today = today or exchange_today()
    now = now or datetime.now(UTC).replace(tzinfo=None)

    round_ = pull_log.current()
    owns_round = round_ is None
    if owns_round:
        round_ = pull_log.begin(source or "Live price refresh", mode="auto (TTL-due only)")
    try:
        due = instruments_due_for_refresh(session, cache, now=now)
        if not due:
            round_.note("no instruments due for refresh (all within their TTL)")
            return {}

        symbols_to_fetch: list[str] = []
        earliest_per_symbol: dict[str, date] = {}
        latest_dates = prices_repo.latest_price_dates(cache, [i.id for i in due])
        provider_symbols = instrument_overrides_repo.provider_symbol_map(session)
        fetch_sym = {i.id: fetch_symbol(i.symbol, provider_symbols.get(i.id)) for i in due}
        for instr in due:
            latest = latest_dates.get(instr.id)
            start = (
                (latest + timedelta(days=1)) if latest is not None else today - timedelta(days=14)
            )
            # Always fetch today's window so intraday closes overwrite stale rows.
            start = min(start, today)
            symbols_to_fetch.append(fetch_sym[instr.id])
            earliest_per_symbol[fetch_sym[instr.id]] = start

        fetch_start = min(earliest_per_symbol.values())
        fetch_end = today + timedelta(days=1)
        round_.requested_window(
            "yfinance",
            symbols_to_fetch,
            fetch_start,
            fetch_end,
            detail=f"{len(due)} due",
        )
        try:
            closes_by_symbol = fetch_closes(
                symbols_to_fetch,
                fetch_start,
                fetch_end,
                # NAV funds publish hours after the close: empty is "waiting", not a fault.
                expected_gaps={fetch_sym[i.id] for i in due if i.asset_class in _NAV_ASSET_CLASSES},
            )
        except YFinanceError as exc:
            # A hard yfinance failure no longer ends the cycle: fall through with
            # no primary data so the Tiingo fallback can still cover the gap. Every
            # due symbol counts as a primary failure for the gates.
            round_.provider_failed("yfinance", f"{exc}; attempting Tiingo fallback")
            closes_by_symbol = {}
        else:
            # Note which tickers we just asked yfinance for, so Settings can report it.
            fetch_report.record("yfinance", symbols_to_fetch)

        # Best-effort: stamp *when each price is from* on the exchange alongside the
        # pull time, so the settled-today caption can date the figure by the
        # provider's market time (e.g. a mutual fund's NAV publish time) instead of
        # our fetch instant. Isolated so a quote-timing failure never disturbs the
        # price refresh itself.
        try:
            market_times = fetch_market_times(symbols_to_fetch) if closes_by_symbol else {}
        except Exception:  # pragma: no cover - defensive: never break the refresh
            log.debug("market-time capture failed; continuing without it", exc_info=True)
            market_times = {}
        stalled = _observe_feed(
            session, due, fetch_sym, closes_by_symbol, market_times, now=now, today=today
        )
        if stalled:
            round_.note(
                "price feed stalled: quotes unchanged / old market time; "
                "not Live, no graph points stored"
            )

        result: dict[str, int] = {}
        written_ids: list[int] = []
        # Closes that are new or changed (a NAV that just posted, a final close):
        # while the market is shut they rebuild the stored daily points below.
        before = prices_repo.recent_closes_by_instrument(
            cache, [i.id for i in due], on_or_before=today, limit=10
        )
        changed_from: date | None = None
        # When the whole yfinance batch fails (hard error), skip the per-symbol
        # write loop entirely so the result stays ``{}`` (the long-standing
        # "nothing happened" contract) and the Tiingo fallback alone decides what
        # to recover.
        if closes_by_symbol:
            for instr in due:
                closes = closes_by_symbol.get(fetch_sym[instr.id], {})
                cutoff = earliest_per_symbol.get(fetch_sym[instr.id], fetch_start)
                filtered = {d: c for d, c in closes.items() if d >= cutoff}
                known = dict(before.get(instr.id, []))
                fresh = [d for d, c in filtered.items() if d <= today and known.get(d) != c]
                if fresh:
                    first = min(fresh)
                    changed_from = first if changed_from is None else min(changed_from, first)
                result[instr.symbol] = prices_repo.upsert_closes(cache, instr.id, filtered)
                if result[instr.symbol]:
                    written_ids.append(instr.id)
                # Stamp the refresh time for *every* instrument we successfully
                # queried, not just those that returned new closes. Otherwise the
                # per-symbol "updated" time on the overview freezes whenever the feed
                # has nothing new (after hours / weekends / NAV not yet published),
                # leaving it stuck at the last time a price actually changed. The "as
                # of" date still reflects the real (possibly older) observation date.
                price_cache_repo.upsert_last_refreshed_at(
                    cache, instr.id, now, market_time=market_times.get(fetch_sym[instr.id])
                )
            round_.settled("yfinance", result)
            _report_suspect_data(cache, {i.symbol: i for i in due}, written_ids, round_)

        _maybe_run_tiingo_fallback(
            session,
            cache,
            due=due,
            now=now,
            today=today,
            # The fallback works in ledger symbols; re-key the provider's answer.
            # While the feed is stalled, today's frozen intraday quotes are not
            # real data: hide them so the backup covers those symbols.
            primary_closes={
                i.symbol: _without_frozen_today(
                    closes_by_symbol[fetch_sym[i.id]], i, today=today, stalled=stalled
                )
                for i in due
                if fetch_sym[i.id] in closes_by_symbol
            },
            result=result,
        )
        if changed_from is not None:
            rebuild_settled_snapshots(session, changed_from, today=today, now=now)
        return result
    finally:
        if owns_round:
            pull_log.end(round_)


def _is_intraday_instrument(instr: Instrument) -> bool:
    return (
        instr.asset_class not in NAV_ASSET_CLASSES
        and instr.asset_class not in SYNTHETIC_ASSET_CLASSES
    )


def _without_frozen_today(
    closes: dict[date, Decimal], instr: Instrument, *, today: date, stalled: bool
) -> dict[date, Decimal]:
    if not stalled or not _is_intraday_instrument(instr):
        return closes
    return {d: c for d, c in closes.items() if d != today}


def _fill_gaps_in_background() -> None:
    """A stall just ended: fill its hole in the graphs from Tiingo, off the pull thread.

    yfinance rarely publishes the missing bars afterwards (5 Nov 2026: never), so
    with a Tiingo token the gap is filled right away. Budget-gated and best-effort.
    """
    import threading  # noqa: PLC0415

    def run() -> None:
        from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
        from investment_dashboard.services import intraday_snapshots_service  # noqa: PLC0415

        try:
            with ledger_session_scope() as session:
                intraday_snapshots_service.fill_gaps_from_tiingo(session)
        except Exception as exc:  # pragma: no cover - budget/network: log and move on
            log.info("automatic Tiingo gap fill after a stall did not run: %s", exc)

    threading.Thread(target=run, name="tiingo-gap-fill", daemon=True).start()


def _observe_feed(
    session: Session,
    instruments: Sequence[Instrument],
    fetch_sym: dict[int, str],
    closes_by_symbol: dict[str, dict[date, Decimal]],
    market_times: dict[str, datetime],
    *,
    now: datetime,
    today: date,
) -> bool:
    """Feed this pull's stock/ETF quotes to the stall detector; ``True`` if stalled.

    Never raises: stall detection must not break a price refresh.
    """
    from investment_dashboard.services import feed_stall_service  # noqa: PLC0415

    try:
        now_utc = now if now.tzinfo is not None else now.replace(tzinfo=UTC)
        quotes: dict[str, Decimal] = {}
        times: list[datetime] = []
        for instr in instruments:
            if not _is_intraday_instrument(instr):
                continue
            sym = fetch_sym[instr.id]
            close = closes_by_symbol.get(sym, {}).get(today)
            if close is not None:
                quotes[sym] = close
            if sym in market_times:
                times.append(market_times[sym])
        change = feed_stall_service.observe_pull(
            session,
            now=now_utc,
            market_open=is_us_market_open(now_utc),
            quotes=quotes,
            newest_market_time=max(times) if times else None,
        )
        if change.started is not None:
            # The points stored while the detector was still counting identical
            # pulls already repeat the frozen quote: take them out again.
            from investment_dashboard.services import intraday_snapshots_service  # noqa: PLC0415

            intraday_snapshots_service.drop_samples_after(session, change.started, now_utc)
        if change.ended is not None and _resolve_tiingo_token():
            _fill_gaps_in_background()
        return feed_stall_service.is_stalled()
    except Exception:  # pragma: no cover - defensive
        log.warning("price-feed stall check failed", exc_info=True)
        return False


def rebuild_settled_snapshots(
    session: Session, start: date, *, today: date, now: datetime | None = None
) -> int:
    """Recompute the stored daily points from ``start`` to ``today`` after a late close.

    A mutual-fund NAV posts hours after the 16:00 close (and a correction can land
    later still). While the market is shut, a pull that writes a new or changed
    close for a past or the current session recomputes those days' snapshots, so
    the daily graphs are right even if no device was open, and publishes a
    ``refresh`` so the read cache is bumped. During the session today's point is
    recomputed on every read anyway, so nothing is done then. Returns days rebuilt.
    """
    from investment_dashboard.services import refresh_status, snapshots_service  # noqa: PLC0415

    instant = now or datetime.now(UTC)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=UTC)  # callers pass naive UTC
    if is_us_market_open(instant) or start > today:
        return 0
    try:
        rebuilt = snapshots_service.warm_range(session, start, today, force=True)
    except Exception:  # pragma: no cover - defensive: never break the price pull
        log.warning("snapshot rebuild after a late close failed", exc_info=True)
        return 0
    log.info("late close: rebuilt %d daily point(s) from %s", rebuilt, start)
    refresh_status._publish({"type": "refresh", "reason": "late close"})
    return rebuilt


def _maybe_run_tiingo_fallback(
    session: Session,
    cache: Session,
    *,
    due: Sequence[Instrument],
    now: datetime,
    today: date,
    primary_closes: dict[str, dict[date, Decimal]],
    result: dict[str, int],
) -> None:
    """Cover any still-stale symbols via Tiingo when a token is configured.

    Folds the recovered row counts into ``result``. Fully isolated: a missing
    token disables it, and any fallback error is logged and swallowed so the
    primary refresh result always stands.
    """
    token = _resolve_tiingo_token()
    if not token:
        return
    # Imported lazily to avoid a module-load import cycle: the services package
    # __init__ eagerly imports prices_service, while the wiring chain
    # (wiring -> runner -> tiingo_state_repo -> services.tiingo_fallback) imports
    # back into the services package. Deferring keeps the import graph acyclic.
    from investment_dashboard.services import tiingo_fallback_wiring  # noqa: PLC0415

    try:
        recovered, _outcome = tiingo_fallback_wiring.apply_desktop_fallback(
            session,
            cache,
            due=due,
            now_utc=now,
            today=today,
            primary_closes=primary_closes,
            token=token,
        )
    except Exception as exc:  # pragma: no cover - defensive: never break the refresh
        # The backup was needed (a fetch was attempted) but failed. Make it
        # OBVIOUS rather than only logging: record a red runtime error so the UI
        # pops a toast and the Data Health page lists it, mirroring the web
        # companion's banner. Distinguish a spent Tiingo quota (HTTP 429 →
        # RateLimitedError; e.g. our self-budget had room but independent use of
        # the same token burned the real account quota) from an unreachable/
        # misconfigured proxy, since the user acts on each differently. The
        # primary result still stands (we return below), so last-known prices show.
        from investment_dashboard.adapters._retry import RateLimitedError  # noqa: PLC0415
        from investment_dashboard.services import runtime_status  # noqa: PLC0415

        if isinstance(exc, RateLimitedError):
            message = (
                f"Tiingo is rate-limited — its API credits look used up; showing "
                f"last-known prices until the quota resets ({exc})."
            )
        else:
            message = f"Tiingo fallback unreachable — showing last-known prices ({exc})."
        runtime_status.record_error("Price backup (Tiingo)", message)
        # Keep the stack trace in the log file, but skip the logging→runtime_status
        # funnel so we don't also raise a second, vaguer amber toast for the same
        # failure (we just recorded the clear red one above).
        log.warning(
            "Tiingo fallback raised; keeping primary result",
            exc_info=True,
            extra={"runtime_status_skip": True},
        )
        return
    for symbol, rows in recovered.items():
        result[symbol] = result.get(symbol, 0) + rows


class TiingoNotConfiguredError(RuntimeError):
    """Raised by :func:`refresh_via_tiingo` when no Tiingo token is configured."""


def refresh_via_tiingo(
    session: Session,
    cache_session: Session | None = None,
    *,
    today: date | None = None,
    now: datetime | None = None,
) -> tuple[dict[str, int], bool]:
    """User-initiated "Refresh via Tiingo now" — bypass the timing gates only.

    Unlike the automatic fallback (which only fires after yfinance has failed and
    the per-symbol grace + confirmed-repeat-failure timing has elapsed), this is an
    explicit user action: it considers *all* active, non-synthetic instruments
    (not just the TTL-due ones) and skips the timing gates, but still enforces the
    worth-it gate (newer data must actually exist — else it's a no-op, never a
    wasted call) and the per-side budget caps. NAV funds still flow through the
    peer-confirmation/canary structure, so a manual NAV refresh before publication
    costs at most a single canary probe.

    Returns ``({symbol: rows_written}, switched)`` where ``switched`` is whether
    any Tiingo data was actually merged. Raises :class:`TiingoNotConfiguredError`
    when no token is set so the UI can prompt the user to add one in Settings.
    """
    cache = cache_session if cache_session is not None else session
    today = today or exchange_today()
    now = now or datetime.now(UTC).replace(tzinfo=None)
    token = _resolve_tiingo_token()
    if not token:
        raise TiingoNotConfiguredError(
            "No Tiingo token configured. Add one under Settings to enable the "
            "secondary price source."
        )

    inactive = instrument_overrides_repo.not_fetched_ids(session)
    instruments = [
        instr
        for instr in instruments_repo.list_instruments(session)
        if instr.asset_class not in _SYNTHETIC_ASSET_CLASSES and instr.id not in inactive
    ]
    if not instruments:
        return {}, False

    from investment_dashboard.services import tiingo_fallback_wiring  # noqa: PLC0415

    round_ = pull_log.current()
    owns_round = round_ is None
    if owns_round:
        round_ = pull_log.begin(
            "Manual Tiingo re-pull (Settings)", mode="manual Tiingo-only fallback"
        )
    try:
        recovered, outcome = tiingo_fallback_wiring.apply_desktop_fallback(
            session,
            cache,
            due=instruments,
            now_utc=now,
            today=today,
            primary_closes={},
            token=token,
            manual=True,
        )
        return recovered, outcome.switched
    finally:
        if owns_round:
            pull_log.end(round_)


# -- manual market-data fixes (Health & Repair → Market data) --------------------
#
# A hand-entered close or split is stored with ``source="manual"`` and is never
# overwritten by a refresh (the repositories' upserts skip manual rows). Every
# change invalidates the valuation snapshots from its date and publishes a
# ``refresh`` event. Closes are native currency (currency rule).

MANUAL_SOURCE = prices_repo.MANUAL_SOURCE


def _market_data_changed(session: Session, from_date: date) -> None:
    from investment_dashboard.services import refresh_status, snapshots_service  # noqa: PLC0415

    snapshots_service.invalidate_from(session, from_date)
    refresh_status._publish({"type": "refresh", "reason": "manual market data"})


def _check_instrument(session: Session, instrument_id: int) -> None:
    from investment_dashboard.errors import NotFoundError  # noqa: PLC0415

    if instruments_repo.get_instrument(session, instrument_id) is None:
        raise NotFoundError(f"instrument {instrument_id} not found")


def list_closes(
    session: Session,
    instrument_id: int,
    *,
    start: date | None = None,
    end: date | None = None,
) -> list[tuple[date, Decimal, str]]:
    """``(date, close, source)`` for ``instrument_id`` in ``[start, end]``."""
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    _check_instrument(session, instrument_id)
    with cache_read_session(session) as cache:
        return prices_repo.list_closes(cache, instrument_id, start=start, end=end)


def set_manual_close(session: Session, instrument_id: int, on: date, close: Decimal) -> None:
    """Pin the close of ``instrument_id`` on ``on`` (protected from refreshes)."""
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415
    from investment_dashboard.errors import ValidationError  # noqa: PLC0415

    _check_instrument(session, instrument_id)
    if not close.is_finite() or close <= 0:
        raise ValidationError("a close must be a positive number")
    with cache_write_session(session) as cache:
        prices_repo.upsert_closes(
            cache, instrument_id, {on: close}, source=MANUAL_SOURCE, overwrite_manual=True
        )
    log.info("manual close set: instrument %s on %s", instrument_id, on)
    _market_data_changed(session, on)


def clear_manual_close(session: Session, instrument_id: int, on: date) -> bool:
    """Remove a hand-entered close (the next price refresh fills the day again)."""
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415
    from investment_dashboard.errors import NotFoundError  # noqa: PLC0415

    _check_instrument(session, instrument_id)
    with cache_write_session(session) as cache:
        row = prices_repo.get_close_row(cache, instrument_id, on)
        if row is None:
            raise NotFoundError(f"no close stored on {on}")
        prices_repo.delete_close(cache, instrument_id, on)
    log.info("close removed: instrument %s on %s (was %s)", instrument_id, on, row[1])
    _market_data_changed(session, on)
    return row[1] == MANUAL_SOURCE


def list_anomalies(session: Session) -> list[int]:
    """Ids of active instruments with a corrupt (non-positive) cached close."""
    ids = sorted(instruments_repo.list_ids(session))
    return sorted(instruments_with_price_anomalies(session, ids))


def list_splits(session: Session, instrument_id: int) -> list[tuple[date, Decimal, str]]:
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    _check_instrument(session, instrument_id)
    with cache_read_session(session) as cache:
        return splits_repo.list_splits(cache, instrument_id)


def set_manual_split(session: Session, instrument_id: int, on: date, ratio: Decimal) -> None:
    """Add/replace a split (``ratio`` = shares after / before; ``1`` cancels a bad feed split)."""
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415
    from investment_dashboard.errors import ValidationError  # noqa: PLC0415

    _check_instrument(session, instrument_id)
    if not ratio.is_finite() or ratio <= 0 or ratio > 1000:
        raise ValidationError("a split ratio must be between 0 and 1000")
    with cache_write_session(session) as cache:
        splits_repo.upsert_splits(
            cache, instrument_id, {on: ratio}, source=MANUAL_SOURCE, overwrite_manual=True
        )
    log.info("manual split set: instrument %s on %s ratio %s", instrument_id, on, ratio)
    # A split rescales every earlier day's share count.
    _market_data_changed(session, date.min)


def delete_split(session: Session, instrument_id: int, on: date) -> None:
    """Delete a split row (a feed split comes back on the next split refresh)."""
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415
    from investment_dashboard.errors import NotFoundError  # noqa: PLC0415

    _check_instrument(session, instrument_id)
    with cache_write_session(session) as cache:
        if not splits_repo.delete_split(cache, instrument_id, on):
            raise NotFoundError(f"no split stored on {on}")
    log.info("split removed: instrument %s on %s", instrument_id, on)
    _market_data_changed(session, date.min)
