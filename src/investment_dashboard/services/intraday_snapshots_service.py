"""Intraday-snapshots service — captures, reconstructs + serves the "1 Day" curve.

The longer-range Overview curves read one cached value *per day*
(:mod:`investment_dashboard.services.snapshots_service`). A "Day" range built on
that has at most one or two points, so it draws a near-empty line. This service
keeps the *within-day* shape instead.

The trick that makes the curve robust is **decomposition**: every stored sample
holds only the EUR value of the *intraday-priced* holdings (stocks/ETFs), not
the whole-portfolio total. The constant base — cash plus NAV holdings (mutual
funds and money-market funds, which print at most one NAV a day) — is added back
once, at render time. Because that base is never baked into the samples, the two
capture sources below always sit on a single consistent basis, and a holding
whose NAV is revalued after the close (a mutual fund) only shifts the whole
curve uniformly instead of spiking it at the instants captured before the
revaluation, or stepping the curve where a live-watched stretch meets a
reconstructed one.

Two complementary sources feed the samples:

* **Live capture** — :func:`record_if_market_open` appends a market-component
  sample on every successful price refresh **while the US market is open**, so
  the curve only ever contains real market-time points and grows denser the more
  often the app auto-updates prices. A small dedupe floor collapses bursts (a
  page-load refresh + the periodic tick firing within seconds).
* **Reconstruction** — :func:`reconstruct_last_session` backfills the most recent
  trading session at ~15-minute granularity from the price feed's intraday bars,
  so opening the app late in the day, after the close, or over a weekend still
  shows a full "1 Day" curve for the last trading day rather than a stub. It
  fills *gaps* only: any 15-minute mark already captured live is left untouched,
  so a live-watched stretch keeps its denser, real points.

:func:`day_series_market_eur` returns the current session's merged market
components; :func:`build_intraday_value_series` (in the Overview query layer)
adds the settled cash + NAV base, converts to the display currency, localises to
the user's timezone, and caps with the live current value — *pinned to the
market close* (:func:`session_close_utc`) once the session is over, so the curve
ends when the market closes rather than trailing a flat line overnight or all
weekend.

Holdings without intraday prices stay **constant** through the session, so they
neither distort the intraday shape nor drop out of the total: cash and all NAV
holdings (mutual funds, money-market funds) ride in the render-time base, while a
market-priced holding the feed served no intraday bars for is simply carried at a
flat ratio of 1.

The most recent *week* of trading sessions is retained (see
:data:`WEEK_SESSIONS`); older samples are pruned as fresh ones land. Keeping a
rolling week — rather than only the current session — lets the Overview "1 Week"
curve reuse the very same cached intraday points (including today's dense live
captures) instead of re-fetching the whole week from the feed on every render.
The data is pure cache, regenerable as the app keeps running.
"""

from __future__ import annotations

import logging
import threading
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from investment_dashboard.domain.market_hours import is_us_market_holiday, is_us_market_open
from investment_dashboard.repositories import app_config_repo, intraday_repo

if TYPE_CHECKING:
    from investment_dashboard.services.positions_service import Position

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

#: Bar width used to reconstruct a missed session — the user's "every 15 min".
RECONSTRUCT_INTERVAL = "15m"

#: Half-window (seconds) around a reconstructed bar within which an existing live
#: sample counts as "already covered". Reconstruction only *backfills*: a 15-min
#: bar is skipped when a live sample already sits inside its slot, so a
#: live-watched stretch keeps its denser, real points instead of being thinned to
#: the coarse 15-min grid. 7.5 min = half the bar width, so each bar is suppressed
#: only by a live sample inside its own slot (never by one in a neighbouring slot).
RECONSTRUCT_COVERAGE_GAP_SECONDS = 7 * 60 + 30

#: ``app_config`` key recording the last session date we reconstructed, so we
#: fetch intraday bars at most once per session instead of on every page load.
_RECONSTRUCTED_KEY = "intraday_reconstructed_day"

#: ``app_config`` key *prefix* recording, per session day, the anchor session for
#: which the Overview "Week" curve last fetched that day's intraday bars. Stored
#: as ``{prefix}{day}`` → ``{anchor_session}`` so a missing day is fetched at most
#: once per session (it is re-attempted only once the anchor session rolls on),
#: mirroring :data:`_RECONSTRUCTED_KEY` for the "1 Day" reconstruction.
_WEEK_FETCHED_PREFIX = "intraday_week_fetched:"

#: Number of recent trading sessions the Overview "Week" (1W) curve spans.
WEEK_SESSIONS = 5

#: Bar width used to source the "Week" curve's intraday path. Only three points
#: per day are kept (start / midday / close), so a coarse bar is plenty and keeps
#: the multi-day download small.
WEEK_INTERVAL = "30m"

#: Smallest share count treated as a real holding (mirrors the Overview filter).
_MIN_SHARES = Decimal("0.0000001")

#: Asset classes that price at most once a day (a NAV) rather than intraday, plus
#: cash-like balances. Their value is carried in the render-time base, never in
#: the stored samples, so it can't distort or spike the intraday curve. Money
#: market funds share the broad ``mutual_fund`` class (see
#: :mod:`investment_dashboard.domain.money_market`), so this one set covers them.
_NAV_ASSET_CLASSES = frozenset({"mutual_fund", "cash", "savings"})

#: Serialises reconstruction so two tabs opening at once don't double-fetch.
_reconstruct_lock = threading.Lock()


def is_intraday_priced(position: Position) -> bool:
    """Whether ``position`` has a genuine *intraday* market price (stock/ETF).

    NAV holdings (mutual funds, money-market funds) and cash print at most once a
    day, so they belong in the render-time base, not the intraday samples.
    """
    effective = position.effective
    asset_class = (
        effective.asset_class if effective is not None else position.instrument.asset_class
    )
    return asset_class not in _NAV_ASSET_CLASSES


def _is_usd_native(position: Position) -> bool:
    """Whether ``position``'s EUR value moves with the EUR/USD rate.

    Only USD-booked holdings are revalued against the intraday EUR/USD bars we
    fetch (USD is the booked currency; EUR is the FX-derived view). EUR-native
    holdings are FX-independent, and other currencies have no intraday FX feed
    here, so both keep the day's settled rate — a safe, uniform fallback.
    """
    return position.account.native_currency.upper() == "USD"


def market_value_eur(positions: list[Position]) -> Decimal:
    """EUR value of the *intraday-priced* holdings — the stored sample quantity.

    This is the portion of the portfolio that actually moves intraday; the
    constant cash + NAV remainder is added back when the curve is rendered.
    """
    return sum(
        (
            p.current_value_eur
            for p in positions
            if p.shares > _MIN_SHARES and is_intraday_priced(p)
        ),
        start=Decimal(0),
    )


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
    """Append one intraday market-component sample when the US market is open.

    Stores only the EUR value of the intraday-priced holdings (stocks/ETFs); the
    cash + NAV base is reapplied at render time, so a mutual fund's post-close
    NAV revaluation can never spike the curve at the live points captured before
    it (see the module docstring). The live EUR→USD spot at the capture instant
    is stored alongside, so the point can later be re-expressed in either currency
    at that minute's *true* rate rather than a single uniform conversion.

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
    from investment_dashboard.services import fx_service, positions_service  # noqa: PLC0415

    captured_at = _to_naive_utc(now)
    try:
        with ledger_session_scope() as session:
            positions = positions_service.compute_positions(session)
            value_eur = market_value_eur(positions)
            # The EUR value above is at today's spot; record that same spot so the
            # USD view of this point is the FX-free price-only figure.
            fx_eur_usd = fx_service.get_rate_eur_to_quote(session, date.today(), quote="USD")
            with cache_write_session(session) as cache:
                last = intraday_repo.latest(cache)
                if (
                    last is not None
                    and (captured_at - last.captured_at).total_seconds() < MIN_CAPTURE_GAP_SECONDS
                ):
                    return False
                intraday_repo.insert_sample(cache, captured_at, value_eur, fx_eur_usd)
                intraday_repo.delete_before(cache, week_window_start_utc(now))
    except Exception:  # pragma: no cover - defensive: capture is best-effort
        log.warning("intraday value capture failed", exc_info=True)
        return False
    return True


def day_series_market_eur(
    session: Session, *, now: datetime | None = None
) -> list[tuple[datetime, Decimal]]:
    """Return ``[(captured_at_utc, market_value_eur), ...]`` for the current session.

    Oldest first. ``captured_at`` is a naive UTC timestamp; the caller localises
    it for display and adds the cash + NAV base. Merges reconstructed + live
    samples. Empty when nothing has been captured or reconstructed yet.
    """
    return [(at, eur) for at, eur, _ in day_series_with_fx(session, now=now)]


def day_series_with_fx(
    session: Session, *, now: datetime | None = None
) -> list[tuple[datetime, Decimal, Decimal | None]]:
    """Return ``[(captured_at_utc, market_value_eur, fx_eur_usd), ...]``, oldest first.

    The FX-aware companion to :func:`day_series_market_eur`: ``fx_eur_usd`` is the
    EUR→USD spot (USD per 1 EUR) struck at each sample's own instant, so the
    render can re-express the curve at the true per-timestamp rate. ``None`` for
    points whose rate was never recorded (legacy rows / no rate sourced), letting
    the caller fall back to today's spot for those.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    now = now or datetime.now(UTC)
    start, end = session_window_utc(now)
    with cache_read_session(session) as cache:
        rows = intraday_repo.list_in_range(cache, start, end)
    return [(r.captured_at, r.market_value_eur, r.fx_eur_usd) for r in rows]


def _market_component_pivot_eur(
    priced: list[Position],
    bars_by_symbol: dict[str, dict[datetime, Decimal]],
    at: datetime,
    *,
    fx_t: Decimal | None,
    base_fx: Decimal | None,
) -> Decimal:
    """EUR pivot of the intraday-priced sleeve at instant ``at``.

    ``Σ value_i · price_i(at)/close_i``, with each USD-booked holding's *derived*
    EUR pivot rebased from the day's settled rate (``base_fx``, baked into
    ``current_value_eur``) to this minute's rate (``fx_t``) so the EUR view tracks
    per-minute FX while the native USD value stays FX-free (recovered at render by
    removing exactly this rate). A symbol the feed served no bar for — or one whose
    bar is a corrupt non-positive close (a known feed glitch that elsewhere flags
    an instrument as anomalous) — is carried at a flat ratio of 1 rather than
    punching a spurious spike into the curve.
    """
    market = Decimal(0)
    for p in priced:
        price_t = _forward_filled(bars_by_symbol.get(p.instrument.symbol, {}), at)
        if price_t is None or price_t <= 0:
            price_t = p.current_price_native
        ratio = price_t / p.current_price_native  # type: ignore[operator]
        contrib = p.current_value_eur * ratio
        if fx_t and base_fx and _is_usd_native(p):
            contrib = contrib * base_fx / fx_t
        market += contrib
    return market


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
    fx_fetcher: object | None = None,
) -> int:
    """Backfill the most recent session's intraday curve from the price feed.

    Fetches ~15-minute intraday bars for the held, intraday-priced instruments on
    the last trading day and records the *market component* per bar — the EUR
    value of those holdings, ``Σ value_i · price_i(t)/close_i``, each USD-booked
    holding re-marked at that minute's **own** EUR/USD rate (from intraday
    ``EURUSD=X`` bars) rather than the day's single settled spot, and the rate
    itself stored alongside. The constant cash + NAV base is added at render time,
    so a holding the feed served no bars for is simply carried flat and the
    reconstruction is on the same basis as the live captures.

    Only *gaps* are filled: a 15-minute mark already captured live is skipped, so
    a live-watched stretch keeps its denser real points.

    Idempotent and guarded: it runs the network fetch at most once per session
    (tracked in ``app_config``) unless ``force`` is set. Best-effort — returns
    the number of points written (0 on any failure / no data), never raises.
    ``fetcher`` / ``fx_fetcher`` override the intraday price / FX sources in tests.
    """
    now = now or datetime.now(UTC)
    session_date = last_session_date(now)
    with _reconstruct_lock:
        # Skip the network fetch only once the session has *actually* been
        # populated. The per-session marker alone is not enough: a first attempt
        # that wrote nothing — a transient feed failure, or opening the app
        # before the bars were published — would otherwise pin the curve empty
        # for the rest of the session (it is never retried). Re-running while the
        # session still holds no samples means the last market day always loads,
        # no matter when the app is opened (e.g. before the next session's open).
        # A portfolio with no intraday-priced holdings still short-circuits cheaply
        # inside ``_reconstruct_session`` (before any network call), so this never
        # spams the feed for a genuinely empty day.
        if (
            not force
            and _already_reconstructed(session, session_date)
            and _session_has_samples(session, session_date)
        ):
            return 0
        try:
            written = _reconstruct_session(
                session, session_date, fetcher=fetcher, fx_fetcher=fx_fetcher
            )
        except Exception:  # pragma: no cover - defensive: best-effort backfill
            log.warning("intraday session reconstruction failed", exc_info=True)
            return 0
        # Mark the attempt done either way so a holiday / empty day doesn't
        # re-hit the network on every page load; ``force`` bypasses the guard.
        _mark_reconstructed(session, session_date)
        return written


def _reconstruct_session(
    session: Session,
    session_date: date,
    *,
    fetcher: object | None,
    fx_fetcher: object | None = None,
) -> int:
    from investment_dashboard.adapters import yfinance_client  # noqa: PLC0415
    from investment_dashboard.db import cache_read_session, cache_write_session  # noqa: PLC0415
    from investment_dashboard.services import fx_service, positions_service  # noqa: PLC0415

    positions = positions_service.compute_positions(session, as_of=session_date)
    priced = [
        p
        for p in positions
        if p.shares > _MIN_SHARES
        and p.current_price_native is not None
        and p.current_price_native != 0
        and p.current_value_eur != 0
        and is_intraday_priced(p)
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

    # Per-timestamp EUR/USD bars so the *derived* EUR pivot of each USD-booked
    # holding can be expressed at the rate actually struck at that minute. USD is
    # the booked currency and stays FX-free (price only); only the EUR view needs
    # a rate. ``base_fx`` is the settled rate the positions' EUR values are already
    # expressed at, used to rebase the pivot to each minute's rate. Both are
    # best-effort: a missing intraday rate forward-fills / falls back to
    # ``base_fx``, leaving the pivot at the day's settled rate rather than failing.
    needs_fx = any(_is_usd_native(p) for p in priced)
    base_fx = fx_service.get_rate_eur_to_quote(session, session_date, quote="USD")
    fx_bars: dict[datetime, Decimal] = {}
    if needs_fx and base_fx:
        fx_fetch = fx_fetcher or yfinance_client.fetch_eur_usd_intraday
        try:
            fx_bars = fx_fetch(  # type: ignore[operator]
                session_date, interval=RECONSTRUCT_INTERVAL
            )
        except Exception:  # pragma: no cover - defensive: FX overlay is best-effort
            log.warning("intraday EUR/USD reconstruction fetch failed", exc_info=True)
            fx_bars = {}

    # Backfill gaps only: keep every instant already captured live and skip any
    # reconstructed bar that falls inside a live sample's slot, so a live-watched
    # stretch keeps its denser real points.
    with cache_read_session(session) as cache:
        live_times = [
            r.captured_at
            for r in intraday_repo.list_in_range(
                cache, _session_start_utc(session_date), bar_times[-1]
            )
        ]

    written = 0
    with cache_write_session(session) as cache:
        for t in bar_times:
            if _covered_by_live(live_times, t):
                continue
            # The rate struck at this minute (forward-filled), or the day's
            # settled spot when no intraday FX is available.
            fx_t = _forward_filled(fx_bars, t) if fx_bars else None
            point_fx = fx_t or base_fx
            # The intraday-priced (market) component only — the cash + NAV base is
            # reapplied at render time, keeping reconstruction on the same basis
            # as the live captures.
            market = _market_component_pivot_eur(
                priced, bars_by_symbol, t, fx_t=fx_t, base_fx=base_fx
            )
            intraday_repo.insert_sample(cache, t, market, point_fx)
            written += 1
        intraday_repo.delete_before(cache, _week_window_start_for(session_date))
    return written


def _covered_by_live(live_times: list[datetime], at: datetime) -> bool:
    """Whether a live sample sits within the coverage half-window of ``at``."""
    return any(
        abs((t - at).total_seconds()) <= RECONSTRUCT_COVERAGE_GAP_SECONDS for t in live_times
    )


def _already_reconstructed(session: Session, session_date: date) -> bool:
    return app_config_repo.get(session, _RECONSTRUCTED_KEY) == session_date.isoformat()


def _session_has_samples(session: Session, session_date: date) -> bool:
    """Whether any intraday sample is already stored for ``session_date``.

    Used to decide whether a reconstruction marked "done" can be trusted: if the
    session window holds no samples at all, the prior attempt produced nothing
    (a failed/early fetch), so it is worth retrying rather than leaving the "1
    Day" curve stuck on a bare live tip.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    start = _session_start_utc(session_date)
    end = _session_start_utc(session_date + timedelta(days=1))
    with cache_read_session(session) as cache:
        return bool(intraday_repo.list_in_range(cache, start, end))


def _mark_reconstructed(session: Session, session_date: date) -> None:
    app_config_repo.set_value(session, _RECONSTRUCTED_KEY, session_date.isoformat())


def recent_trading_sessions(
    now: datetime | None = None, *, count: int = WEEK_SESSIONS
) -> list[date]:
    """The most recent ``count`` trading sessions, oldest first.

    Anchored on :func:`last_session_date` and walked back over weekends/holidays
    with :func:`previous_trading_session`, so the "Week" curve always spans real
    sessions rather than a fixed seven calendar days.
    """
    day = last_session_date(now)
    days = [day]
    for _ in range(max(0, count - 1)):
        day = previous_trading_session(day)
        days.append(day)
    return sorted(days)


def _week_window_start_for(anchor: date) -> datetime:
    """Naive-UTC start of the oldest session in the week window ending ``anchor``.

    Walks back :data:`WEEK_SESSIONS` − 1 trading sessions from ``anchor`` (the
    most recently started session) and returns 00:00 exchange-time of that oldest
    day. This is the prune cutoff for the intraday cache: everything from here up
    to the live tip is the rolling week the "1 Week" curve reuses, so a sample is
    only dropped once it ages out of the whole window rather than out of a single
    session.
    """
    day = anchor
    for _ in range(max(0, WEEK_SESSIONS - 1)):
        day = previous_trading_session(day)
    return _session_start_utc(day)


def week_window_start_utc(now: datetime | None = None) -> datetime:
    """Naive-UTC start of the oldest session in the current week window."""
    return _week_window_start_for(last_session_date(now))


def _pick_open_mid_close(bar_times: list[datetime]) -> list[datetime]:
    """Choose a day's start / midday / close instants from its sorted bar times.

    Returns up to three distinct timestamps (fewer when the day has fewer bars):
    the first bar (start), the bar nearest the open→close midpoint (midday) and
    the last bar (close). Preserves chronological order.
    """
    if not bar_times:
        return []
    if len(bar_times) <= 3:
        return list(bar_times)
    first, last = bar_times[0], bar_times[-1]
    midpoint = first + (last - first) / 2
    mid = min(bar_times, key=lambda t: abs((t - midpoint).total_seconds()))
    chosen = sorted({first, mid, last})
    return chosen


def week_series_with_fx(
    session: Session,
    *,
    now: datetime | None = None,
    fetcher: object | None = None,
    fx_fetcher: object | None = None,
) -> list[tuple[datetime, Decimal, Decimal | None]]:
    """Start / midday / close market-component samples over the last week's sessions.

    Returns ``[(at_utc, market_value_eur, fx_eur_usd), ...]`` (oldest first) — the
    same shape as :func:`day_series_with_fx`, so the render path
    (:func:`build_week_value_series`) can reapply the cash + NAV base and convert
    to either currency with the identical per-minute FX model used by the "1 Day"
    curve. USD stays FX-free (booked currency); EUR is derived at each bar's own
    EUR/USD rate, so the two currency lines genuinely diverge across the week.

    Each session is repriced against *that day's* held positions (so a buy or
    sell mid-week is reflected), with three representative instants kept per day
    for a smooth-yet-cheap curve.

    **Cache-first.** The rolling-week intraday cache (live "1 Day" captures plus
    previously-fetched/reconstructed earlier days — all on the identical EUR
    market-component basis) is read first, and only sessions with *no* cached
    coverage trigger a network fetch. Today's dense live captures are therefore
    reused verbatim inside the week curve instead of being re-downloaded. Freshly
    fetched bars are *persisted* (same shape the "1 Day" path writes), so a later
    render serves them straight from cache, and each missing day is fetched at
    most once per session (guarded by :data:`_WEEK_FETCHED_PREFIX`).

    Best-effort and network-backed: returns ``[]`` when nothing is cached and no
    intraday bars could be sourced, letting the caller fall back to the daily
    snapshot series.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    now = now or datetime.now(UTC)
    sessions = recent_trading_sessions(now)
    if not sessions:
        return []
    anchor = sessions[-1]
    week_start = _session_start_utc(sessions[0])
    window_end = min(_to_naive_utc(now), _session_start_utc(sessions[-1] + timedelta(days=1)))

    # 1. Cache first — the rolling week already on hand. A session counts as
    #    "covered" the moment it holds any cached sample (e.g. today's live
    #    captures), so it is never re-fetched.
    with cache_read_session(session) as cache:
        cached = [
            (r.captured_at, r.market_value_eur, r.fx_eur_usd)
            for r in intraday_repo.list_in_range(cache, week_start, window_end)
        ]

    def _is_covered(session_date: date) -> bool:
        start = _session_start_utc(session_date)
        end = _session_start_utc(session_date + timedelta(days=1))
        return any(start <= at < end for at, _, _ in cached)

    # 2. Fetch only the gaps, and only days not already attempted this session.
    to_fetch = [
        d for d in sessions if not _is_covered(d) and not _week_day_fetched(session, d, anchor)
    ]

    fetched: list[tuple[datetime, Decimal, Decimal | None]] = []
    if to_fetch:
        fetched = _fetch_and_persist_week_days(
            session, to_fetch, anchor, week_start, fetcher=fetcher, fx_fetcher=fx_fetcher
        )

    # 3. Merge cached + freshly fetched (disjoint by session), oldest first.
    merged: dict[datetime, tuple[datetime, Decimal, Decimal | None]] = {}
    for sample in [*cached, *fetched]:
        merged[sample[0]] = sample
    return sorted(merged.values(), key=lambda s: s[0])


def _priced_intraday_positions(session: Session, session_date: date) -> list[Position]:
    """Held, intraday-priced positions as of ``session_date`` (the week sleeve)."""
    from investment_dashboard.services import positions_service  # noqa: PLC0415

    return [
        p
        for p in positions_service.compute_positions(session, as_of=session_date)
        if p.shares > _MIN_SHARES
        and p.current_price_native is not None
        and p.current_price_native != 0
        and p.current_value_eur != 0
        and is_intraday_priced(p)
    ]


def _build_week_day_samples(
    session: Session,
    session_date: date,
    priced: list[Position],
    bars_by_symbol: dict[str, dict[datetime, Decimal]],
    fx_bars: dict[datetime, Decimal],
) -> list[tuple[datetime, Decimal, Decimal | None]]:
    """Start / midday / close market-component samples for one session day."""
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    start = _session_start_utc(session_date)
    end = _session_start_utc(session_date + timedelta(days=1))
    day_symbols = {p.instrument.symbol for p in priced}
    day_bar_times = sorted(
        {t for sym in day_symbols for t in bars_by_symbol.get(sym, {}) if start <= t < end}
    )
    if not day_bar_times:
        return []
    base_fx = (
        fx_service.get_rate_eur_to_quote(session, session_date, quote="USD")
        if any(_is_usd_native(p) for p in priced)
        else None
    )
    samples: list[tuple[datetime, Decimal, Decimal | None]] = []
    for t in _pick_open_mid_close(day_bar_times):
        fx_t = _forward_filled(fx_bars, t) if fx_bars else None
        point_fx = fx_t or base_fx
        market = _market_component_pivot_eur(priced, bars_by_symbol, t, fx_t=fx_t, base_fx=base_fx)
        samples.append((t, market, point_fx))
    return samples


def _fetch_and_persist_week_days(
    session: Session,
    to_fetch: list[date],
    anchor: date,
    week_start: datetime,
    *,
    fetcher: object | None,
    fx_fetcher: object | None,
) -> list[tuple[datetime, Decimal, Decimal | None]]:
    """Fetch, build, persist and mark the uncovered week sessions in ``to_fetch``.

    Returns the freshly built samples (empty when the feed served no bars). Every
    attempted day is marked done so a quiet/offline day doesn't re-hit the network
    on every render this session; it is re-attempted once the anchor session rolls
    on. Best-effort: a network failure is logged and yields no samples.
    """
    from investment_dashboard.adapters import yfinance_client  # noqa: PLC0415
    from investment_dashboard.db import cache_write_session  # noqa: PLC0415

    positions_by_day = {d: _priced_intraday_positions(session, d) for d in to_fetch}
    symbols = sorted({p.instrument.symbol for priced in positions_by_day.values() for p in priced})

    fetched: list[tuple[datetime, Decimal, Decimal | None]] = []
    if symbols:
        needs_fx = any(_is_usd_native(p) for priced in positions_by_day.values() for p in priced)
        fetch = fetcher or yfinance_client.fetch_intraday_closes_range
        try:
            bars_by_symbol: dict[str, dict[datetime, Decimal]] = fetch(  # type: ignore[operator]
                symbols, to_fetch[0], to_fetch[-1], interval=WEEK_INTERVAL
            )
        except Exception:  # pragma: no cover - defensive: best-effort network fetch
            log.warning("week curve intraday fetch failed", exc_info=True)
            bars_by_symbol = {}

        fx_bars: dict[datetime, Decimal] = {}
        if needs_fx and bars_by_symbol:
            fx_fetch = fx_fetcher or yfinance_client.fetch_eur_usd_intraday_range
            try:
                fx_bars = fx_fetch(to_fetch[0], to_fetch[-1], interval=WEEK_INTERVAL)  # type: ignore[operator]
            except Exception:  # pragma: no cover - defensive: FX overlay is best-effort
                log.warning("week curve EUR/USD fetch failed", exc_info=True)
                fx_bars = {}

        for session_date in to_fetch:
            fetched.extend(
                _build_week_day_samples(
                    session, session_date, positions_by_day[session_date], bars_by_symbol, fx_bars
                )
            )

        # Persist what we sourced so the next render reads it from cache, and
        # prune anything older than the rolling week.
        if fetched:
            with cache_write_session(session) as cache:
                for t, market, point_fx in fetched:
                    intraday_repo.insert_sample(cache, t, market, point_fx)
                intraday_repo.delete_before(cache, week_start)

    for session_date in to_fetch:
        _mark_week_day_fetched(session, session_date, anchor)
    return fetched


def _week_day_fetched(session: Session, day: date, anchor: date) -> bool:
    """Whether ``day``'s week-curve bars were already fetched this anchor session."""
    return (
        app_config_repo.get(session, f"{_WEEK_FETCHED_PREFIX}{day.isoformat()}")
        == anchor.isoformat()
    )


def _mark_week_day_fetched(session: Session, day: date, anchor: date) -> None:
    app_config_repo.set_value(
        session, f"{_WEEK_FETCHED_PREFIX}{day.isoformat()}", anchor.isoformat()
    )
