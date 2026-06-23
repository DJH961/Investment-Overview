"""Intraday-snapshots service — captures, reconstructs + serves the "1 Day" curve.

The longer-range Overview curves read one cached value *per day*
(:mod:`investment_dashboard.services.snapshots_service`). A "Day" range built on
that has at most one or two points, so it draws a near-empty line. This service
keeps the *within-day* shape instead, from two complementary sources:

* **Live capture** — :func:`record_if_market_open` appends a portfolio-value
  sample on every successful price refresh **while the US market is open**, so
  the curve only ever contains real market-time points and grows denser the more
  often the app auto-updates prices. A small dedupe floor collapses bursts (a
  page-load refresh + the periodic tick firing within seconds).
* **Reconstruction** — :func:`reconstruct_last_session` backfills the most recent
  trading session at ~30-minute granularity from the price feed's intraday bars,
  so opening the app late in the day, after the close, or over a weekend still
  shows a full "1 Day" curve for the last trading day rather than a stub. It is
  anchored to that day's cached daily total, so only the priced holdings move
  intraday and the curve closes exactly on the day's settled value.

:func:`day_series_eur` returns the current session's merged samples (EUR), which
the Overview "Day" range converts to the display currency, localises to the
user's timezone, and caps with the live current value — *pinned to the market
close* (:func:`session_close_utc`) once the session is over, so the curve ends
when the market closes rather than trailing a flat line overnight or all weekend.

Holdings without intraday prices stay **constant** through the session, so they
neither distort the intraday shape nor drop out of the total, and the curve
still closes on the correct settled value. Cash and money-market funds ride in
the reconstruction's anchored ``base``; mutual funds (which only print one NAV
at the close) are carried at a flat ratio of 1 because the feed serves them no
intraday bars.

Only the most recent session is retained; older samples are pruned as fresh ones
land (the data is pure cache, regenerable as the app keeps running).
"""

from __future__ import annotations

import logging
import threading
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from investment_dashboard.domain.market_hours import is_us_market_holiday, is_us_market_open
from investment_dashboard.repositories import app_config_repo, intraday_repo

log = logging.getLogger(__name__)

#: Exchange clock that defines "today's session" (matches ``domain.market_hours``).
_MARKET_TZ = ZoneInfo("America/New_York")

#: ``datetime.weekday()`` returns 5/6 for Saturday/Sunday.
_SATURDAY = 5

#: Regular cash-session open (local exchange time). A weekday only becomes "the
#: current session" once its market has opened; before then the most recent
#: *started* trading day is still the one shown (see :func:`last_session_date`).
_MARKET_OPEN = time(9, 30)

#: Minimum spacing between stored live samples. A page load and the periodic
#: tick can both fire within a second or two; this collapses such bursts to one
#: point while still keeping every genuine auto-update (the default refresh
#: cadence is comfortably above it).
MIN_CAPTURE_GAP_SECONDS = 20

#: Bar width used to reconstruct a missed session — the user's "every 30 min".
RECONSTRUCT_INTERVAL = "30m"

#: ``app_config`` key recording the last session date we reconstructed, so we
#: fetch intraday bars at most once per session instead of on every page load.
_RECONSTRUCTED_KEY = "intraday_reconstructed_day"

#: Smallest share count treated as a real holding (mirrors the Overview filter).
_MIN_SHARES = Decimal("0.0000001")

#: Serialises reconstruction so two tabs opening at once don't double-fetch.
_reconstruct_lock = threading.Lock()


def _to_naive_utc(now: datetime) -> datetime:
    """Normalise an aware/naive instant to a naive UTC timestamp (storage form)."""
    if now.tzinfo is not None:
        return now.astimezone(UTC).replace(tzinfo=None)
    return now


def _is_trading_day(day: date) -> bool:
    """Whether ``day`` is a weekday the NYSE actually trades (not a holiday)."""
    return day.weekday() < _SATURDAY and not is_us_market_holiday(day)


def previous_trading_session(session_date: date) -> date:
    """The most recent trading day strictly before ``session_date``.

    Holiday- and weekend-aware (unlike
    :func:`domain.market_hours.previous_trading_day`), so the "1 Day" chart's
    prior-close reference line marks the genuine previous *session* even across a
    holiday (e.g. the day before Independence Day, not the holiday itself).
    """
    day = session_date - timedelta(days=1)
    while not _is_trading_day(day):
        day -= timedelta(days=1)
    return day


def last_session_date(now: datetime | None = None) -> date:
    """Exchange date of the most recent trading session that has *started*.

    "Started" matters: a brand-new trading day only becomes the session once its
    market has opened (09:30 exchange time). Before the open — early in the
    morning, all weekend, or on a holiday — the most recent trading day that has
    actually begun is returned, so the "1 Day" curve keeps showing the *last*
    trading session's shape until a fresh session starts rather than blanking out
    on an as-yet-empty day. Weekends and full-day NYSE holidays are skipped (both
    here and when rolling back), and the whole calculation is done in exchange
    time so it is timezone-correct regardless of where the user is.
    """
    now = now or datetime.now(UTC)
    aware = now if now.tzinfo is not None else now.replace(tzinfo=UTC)
    local = aware.astimezone(_MARKET_TZ)
    day = local.date()
    # Today counts as the current session only once it is a trading day *and* its
    # market has opened. Otherwise roll back to the most recent started session.
    if _is_trading_day(day) and local.time() >= _MARKET_OPEN:
        return day
    day -= timedelta(days=1)
    while not _is_trading_day(day):
        day -= timedelta(days=1)
    return day


def _session_start_utc(session_date: date) -> datetime:
    """Naive-UTC instant of 00:00 exchange-time on ``session_date``."""
    start_local = datetime.combine(session_date, time(0, 0), tzinfo=_MARKET_TZ)
    return start_local.astimezone(UTC).replace(tzinfo=None)


def session_window_utc(now: datetime | None = None) -> tuple[datetime, datetime]:
    """``(start, end)`` naive-UTC bounds of the session shown by the "Day" range.

    ``start`` is 00:00 exchange-time of the most recent trading day; ``end`` is
    ``now`` while that session is current, or the day's end once it is in the
    past (so a weekend still bounds Friday's full session).
    """
    now = now or datetime.now(UTC)
    session = last_session_date(now)
    start = _session_start_utc(session)
    session_end = _session_start_utc(session + timedelta(days=1))
    end = min(_to_naive_utc(now), session_end)
    return start, end


def session_close_utc(now: datetime | None = None) -> datetime:
    """Naive-UTC instant of the regular-session close (16:00 ET) for the "Day" session.

    The "1 Day" curve must *end when the market closes* rather than trailing a
    flat line out to the current wall-clock time. Once the session has shut the
    live portfolio value is simply the settled close, so its point is pinned
    here — which also bounds the curve neatly overnight and over a weekend (a
    Saturday shows Friday's session ending at Friday 16:00, not running into
    Saturday). Holidays/half-days are not modelled (see
    :mod:`investment_dashboard.domain.market_hours`).
    """
    from investment_dashboard.domain.market_hours import (  # noqa: PLC0415
        regular_session_close,
    )

    now = now or datetime.now(UTC)
    close = regular_session_close(last_session_date(now))
    return close.astimezone(UTC).replace(tzinfo=None)


def record_if_market_open(*, now: datetime | None = None) -> bool:
    """Append one intraday portfolio-value sample when the US market is open.

    Best-effort and self-pruning: returns ``True`` when a sample was written,
    ``False`` when the market is closed or the dedupe floor suppressed it. Opens
    its own sessions (it runs from the background refresh thread) and never
    raises — a capture failure must never break a price refresh.
    """
    now = now or datetime.now(UTC)
    if not is_us_market_open(now):
        return False

    from investment_dashboard.db import (  # noqa: PLC0415
        cache_write_session,
        ledger_session_scope,
    )
    from investment_dashboard.services import positions_service  # noqa: PLC0415

    captured_at = _to_naive_utc(now)
    try:
        with ledger_session_scope() as session:
            value_eur = positions_service.total_portfolio_value(session)
            with cache_write_session(session) as cache:
                last = intraday_repo.latest(cache)
                if (
                    last is not None
                    and (captured_at - last.captured_at).total_seconds() < MIN_CAPTURE_GAP_SECONDS
                ):
                    return False
                intraday_repo.insert_sample(cache, captured_at, value_eur)
                intraday_repo.delete_before(cache, session_window_utc(now)[0])
    except Exception:  # pragma: no cover - defensive: capture is best-effort
        log.warning("intraday value capture failed", exc_info=True)
        return False
    return True


def day_series_eur(
    session: Session, *, now: datetime | None = None
) -> list[tuple[datetime, Decimal]]:
    """Return ``[(captured_at_utc, value_eur), ...]`` for the current session.

    Oldest first. ``captured_at`` is a naive UTC timestamp; the caller localises
    it for display. Merges reconstructed + live samples. Empty when nothing has
    been captured or reconstructed for the session yet.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    now = now or datetime.now(UTC)
    start, end = session_window_utc(now)
    with cache_read_session(session) as cache:
        rows = intraday_repo.list_in_range(cache, start, end)
    return [(r.captured_at, r.total_value_eur) for r in rows]


def _forward_filled(bars: dict[datetime, Decimal], at: datetime) -> Decimal | None:
    """Latest bar value at/just-before ``at`` (or the earliest, if all later)."""
    if not bars:
        return None
    times = sorted(bars)
    chosen: datetime | None = None
    for t in times:
        if t <= at:
            chosen = t
        else:
            break
    return bars[chosen] if chosen is not None else bars[times[0]]


def reconstruct_last_session(
    session: Session,
    *,
    now: datetime | None = None,
    force: bool = False,
    fetcher: object | None = None,
) -> int:
    """Backfill the most recent session's intraday curve from the price feed.

    Fetches ~30-minute intraday bars for the held, market-priced instruments on
    the last trading day and records a portfolio-value point per bar. The curve
    is anchored to that day's cached daily total, so cash, money-market funds and
    any holding without intraday bars stay constant and the reconstruction closes
    exactly on the settled value:
    ``value(t) = base + Σ value_i · price_i(t)/close_i``.

    Idempotent and guarded: it runs the network fetch at most once per session
    (tracked in ``app_config``) unless ``force`` is set. Best-effort — returns
    the number of points written (0 on any failure / no data), never raises.
    ``fetcher`` overrides the intraday price source in tests.
    """
    now = now or datetime.now(UTC)
    session_date = last_session_date(now)
    with _reconstruct_lock:
        if not force and _already_reconstructed(session, session_date):
            return 0
        try:
            written = _reconstruct_session(session, session_date, fetcher=fetcher)
        except Exception:  # pragma: no cover - defensive: best-effort backfill
            log.warning("intraday session reconstruction failed", exc_info=True)
            return 0
        # Mark the attempt done either way so a holiday / empty day doesn't
        # re-hit the network on every page load; ``force`` bypasses the guard.
        _mark_reconstructed(session, session_date)
        return written


def _reconstruct_session(session: Session, session_date: date, *, fetcher: object | None) -> int:
    from investment_dashboard.adapters import yfinance_client  # noqa: PLC0415
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415
    from investment_dashboard.domain.money_market import is_money_market  # noqa: PLC0415
    from investment_dashboard.services import positions_service  # noqa: PLC0415

    positions = positions_service.compute_positions(session, as_of=session_date)
    priced = [
        p
        for p in positions
        if p.shares > _MIN_SHARES
        and p.current_price_native is not None
        and p.current_price_native != 0
        and p.current_value_eur != 0
        and not is_money_market(p.instrument.symbol)
    ]
    if not priced:
        return 0

    symbols = sorted({p.instrument.symbol for p in priced})
    fetch = fetcher or yfinance_client.fetch_intraday_closes
    bars_by_symbol: dict[str, dict[datetime, Decimal]] = fetch(  # type: ignore[operator]
        symbols, session_date, interval=RECONSTRUCT_INTERVAL
    )
    bar_times = sorted({t for bars in bars_by_symbol.values() for t in bars})
    if not bar_times:
        return 0

    total_eur = positions_service.total_portfolio_value(
        session, as_of=session_date, positions=positions
    )
    base = total_eur - sum((p.current_value_eur for p in priced), start=Decimal(0))

    written = 0
    with cache_write_session(session) as cache:
        for t in bar_times:
            value = base
            for p in priced:
                price_t = _forward_filled(bars_by_symbol.get(p.instrument.symbol, {}), t)
                if price_t is None:
                    price_t = p.current_price_native
                ratio = price_t / p.current_price_native  # type: ignore[operator]
                value += p.current_value_eur * ratio
            intraday_repo.insert_sample(cache, t, value)
            written += 1
        intraday_repo.delete_before(cache, _session_start_utc(session_date))
    return written


def _already_reconstructed(session: Session, session_date: date) -> bool:
    return app_config_repo.get(session, _RECONSTRUCTED_KEY) == session_date.isoformat()


def _mark_reconstructed(session: Session, session_date: date) -> None:
    app_config_repo.set_value(session, _RECONSTRUCTED_KEY, session_date.isoformat())
