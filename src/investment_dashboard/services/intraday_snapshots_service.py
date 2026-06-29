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
  so a live-watched stretch keeps its denser, real points. The coverage guard
  (:func:`_session_is_covered`) re-pulls not just an under-spanned curve but one
  with an *internal hole* — a midday stall where live captures stopped and later
  resumed, or a missing morning — so a transient gap is smartly refilled on the
  next render instead of being drawn as a flat straight line. The "1 Week"
  curve (:func:`week_series_with_fx`) applies the same idea per finished session:
  a day whose cached points don't *span* the open→close is re-pulled to lay down
  that day's full set of 30-minute bars.

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
from bisect import bisect_right
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from investment_dashboard.domain.market_hours import (
    is_us_market_holiday,
    is_us_market_open,
    regular_session_close,
)
from investment_dashboard.domain.money_market import is_money_market
from investment_dashboard.repositories import app_config_repo, intraday_repo

if TYPE_CHECKING:
    from collections.abc import Callable

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

#: Minimum number of stored "1 Day" samples below which a reconstructed session is
#: judged under-covered (a stray bar from a partial / stalled fetch) and re-pulled
#: rather than trusted complete. A single sample carries no time-spread to assess.
RECONSTRUCT_MIN_COVERAGE_SAMPLES = 2

#: Fraction of the elapsed session that the stored "1 Day" samples must *span*
#: before the reconstruction is trusted as complete (a coverage test, not a mere
#: presence test). A morning-only or stray-bar fetch spans too little and is
#: re-pulled — cheap, since the desktop's yfinance primary is unmetered, so we can
#: safely bias toward re-pulling when coverage is uncertain.
RECONSTRUCT_COVERAGE_FRACTION = Decimal("0.6")

#: Largest tolerated hole (seconds) between consecutive "1 Day" samples — and
#: between the session open and the first sample — before the session is judged
#: gappy and re-pulled to fill it. The span check above only measures first→last,
#: so it cannot see a *hole in the middle* (live captures that stalled midday and
#: resumed, leaving a flat straight line across the gap) or a *missing morning*
#: (a late first sample with a still-wide overall span). A fully reconstructed
#: 15-min grid has ~15-min spacing, so 45 min (3 bars) clears a normal curve while
#: still catching a genuine multi-bar gap, which the next render refills.
RECONSTRUCT_MAX_GAP_SECONDS = 45 * 60  # 45 minutes

#: Fraction of a *finished* week session (open→close) that its cached samples must
#: span before that day is trusted complete. Mirrors
#: :data:`RECONSTRUCT_COVERAGE_FRACTION` for the "1 Week" curve: a day left with
#: only clustered morning points (the feed stalled before midday) spans too
#: little, so it is re-pulled to lay down the day's full set of 30-minute bars
#: rather than freezing at a gappy curve. The in-progress anchor session is exempt
#: (it grows from today's dense live captures, gap-filled by the 1D reconstruction).
WEEK_COVERAGE_FRACTION = Decimal("0.6")

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

#: Bar width used to source the "Week" curve's intraday path. Every sourced bar
#: is kept (no token/credit limit on the desktop feed), so a full session yields
#: ~13 genuine 30-minute marks — a coarse-enough bar to keep the multi-day
#: download small while still drawing each day's real intraday shape.
WEEK_INTERVAL = "30m"

#: Minimum number of intraday points a *completed* week session must carry to
#: count as fully sourced. A finished session holding fewer than this is treated
#: as missing data and re-pulled (see ``_is_covered`` in
#: :func:`week_series_with_fx`), so a partial earlier fetch or a single stray live
#: capture can't freeze a day at an incomplete curve. This is only a *floor*:
#: :func:`_pick_session_points` keeps *every* sourced bar (~13/day), well above
#: it. The in-progress session is exempt: its close hasn't happened yet, so it
#: grows from live captures and any sample counts.
WEEK_POINTS_PER_COMPLETE_SESSION = 5

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


def is_drifting_nav(position: Position) -> bool:
    """Whether ``position`` is a NAV mutual fund whose value drifts day to day.

    Ordinary mutual funds publish a fresh NAV every session, so across the
    multi-day "Week" curve their contribution should slope with their dated
    closes rather than ride flat at *today's* NAV (≈ half the book can be funds,
    so a week of flat funds materially understates the curve's movement). Their
    daily close — which *is* the NAV — is already persisted to ``price_history``
    by the normal close pull, so the per-day value is free to read.

    Excluded (they stay in the truly-flat render-time base): cash, savings, and
    money-market / settlement funds (≈ $1.00 NAV), which do not meaningfully
    drift and should never wiggle on the curve.
    """
    effective = position.effective
    asset_class = (
        effective.asset_class if effective is not None else position.instrument.asset_class
    )
    if asset_class != "mutual_fund":
        return False
    name = effective.name if effective is not None else position.instrument.name
    return not is_money_market(position.instrument.symbol, asset_class=asset_class, name=name)


def nav_drift_value_eur(positions: list[Position]) -> Decimal:
    """EUR value of the day-drifting NAV funds among ``positions``.

    Companion to :func:`market_value_eur`: the intraday sleeve moves minute to
    minute, this sleeve moves once per session (its NAV). Both are pulled out of
    the flat render-time base so the "Week" curve can reapply each at its own
    dated value. Money-market funds and cash stay in the flat base.
    """
    return sum(
        (p.current_value_eur for p in positions if p.shares > _MIN_SHARES and is_drifting_nav(p)),
        start=Decimal(0),
    )


def session_date_of(at_utc: datetime) -> date:
    """Exchange (session) date of a naive- or aware-UTC sample instant."""
    aware = at_utc if at_utc.tzinfo is not None else at_utc.replace(tzinfo=UTC)
    return aware.astimezone(_MARKET_TZ).date()


def _nearest_complete_date(target: date, candidates: list[date]) -> date | None:
    """The complete-NAV session date closest to ``target`` (ties → the *later* one).

    Used to gap-fill a session date whose own NAV sleeve could not be valued: it
    inherits the value of the nearest day that *could*, preferring a more recent
    (later) NAV when two are equidistant — the freshest published NAV is the
    better stand-in for a missing one.
    """
    if not candidates:
        return None
    return min(candidates, key=lambda d: (abs((d - target).days), -d.toordinal()))


def week_nav_drift_with_fx(
    session: Session,
    *,
    now: datetime | None = None,
    live_fallback: tuple[Decimal, Decimal | None] | None = None,
) -> dict[date, tuple[Decimal, Decimal | None]]:
    """Per-session NAV-fund EUR value (and that day's settled EUR/USD) for the week.

    For each of the recent trading sessions the "Week" curve plots, the
    day-drifting NAV funds (see :func:`is_drifting_nav`) are revalued at *that
    day's* persisted close — their published NAV — and that day's settled
    EUR/USD rate, so the fund sleeve slopes per-day instead of riding flat at
    today's NAV. The EUR value carries each day's own settled FX so the USD view
    cancels it exactly to native USD (the same currency model the intraday market
    component uses); the rate is returned alongside.

    **Smart, self-correcting gap-fill.** A session date whose drifting funds
    cannot be valued — its NAV close hasn't been pulled yet, or no FX rate exists
    for that date so :func:`positions_service.compute_positions` returns a zero /
    ``value_warning`` EUR value — would otherwise punch the whole NAV sleeve to
    **zero** for that day, nose-diving the start of the "1 Week" curve to roughly
    the value of the stocks *without* their NAV funds (issue #169). Instead such a
    day inherits the nearest *complete* day's dated NAV (and that day's FX), and
    when no day in the window is complete it falls back to ``live_fallback`` —
    today's live NAV value + spot rate, supplied by the caller. This never
    speculatively fetches: the value is re-derived from whatever the cache holds
    on *every* render, so once a later good close-bar / FX pull patches the gap
    the very next render uses the genuine per-day NAV and the curve self-corrects
    in retrospect.

    Reads only the price cache the daily close pulls already populate — no extra
    network fetch. Returns ``{}`` when there are no drifting NAV funds.
    """
    from investment_dashboard.services import fx_service, positions_service  # noqa: PLC0415

    now = now or datetime.now(UTC)
    # First pass: value each session date's drifting sleeve and flag whether the
    # whole sleeve could actually be valued that day (a single unvaluable fund
    # makes the day incomplete, so its zero contribution can't masquerade as a
    # real NAV drop).
    raw: dict[date, tuple[Decimal, Decimal | None, bool]] = {}
    held_dates: list[date] = []
    for session_date in recent_trading_sessions(now):
        positions = positions_service.compute_positions(session, as_of=session_date)
        drifting = [p for p in positions if p.shares > _MIN_SHARES and is_drifting_nav(p)]
        if not drifting:
            continue
        held_dates.append(session_date)
        nav_eur = sum((p.current_value_eur for p in drifting), start=Decimal(0))
        usd_funds = [p for p in drifting if _is_usd_native(p)]
        if usd_funds:
            settled_fx = fx_service.get_rate_eur_to_quote(session, session_date, quote="USD")
            # The sleeve's *native* USD value, FX-free for USD-booked funds (USD is
            # the booked currency): each USD fund contributes its native USD value
            # directly; any non-USD fund is converted at the day's settled rate.
            # Pair ``nav_eur`` with the effective rate that recovers exactly this
            # native USD (``nav_usd / nav_eur``), rather than an independently
            # fetched rate that can disagree with the rate ``nav_eur`` was struck
            # at. That disagreement is what collapsed the USD NAV term while the EUR
            # term stayed flat — the USD-only "1 Week" nosedive of issue #169. With
            # a consistent rate the USD line can never drift from the EUR line.
            nav_usd = sum((p.current_value_native for p in usd_funds), start=Decimal(0))
            if settled_fx is not None:
                nav_usd += (
                    sum(
                        (p.current_value_eur for p in drifting if not _is_usd_native(p)),
                        start=Decimal(0),
                    )
                    * settled_fx
                )
            fx = (nav_usd / nav_eur) if nav_eur > 0 else settled_fx
        else:
            fx = None
        # A day is "complete" only when every drifting fund could actually be
        # valued. ``value_warning`` is the single authoritative signal here: it is
        # set precisely when the holding has no price, a zero native value, or no
        # FX rate (see :func:`positions_service.compute_positions`), so a fund
        # genuinely worth ~0 is *not* mistaken for an unvaluable one.
        complete = all(not p.value_warning for p in drifting)
        raw[session_date] = (nav_eur, fx, complete)

    if not raw:
        return {}

    complete_dates = [d for d, (_eur, _fx, ok) in raw.items() if ok]
    out: dict[date, tuple[Decimal, Decimal | None]] = {}
    for session_date in held_dates:
        nav_eur, fx, complete = raw[session_date]
        if complete:
            out[session_date] = (nav_eur, fx)
            continue
        donor = _nearest_complete_date(session_date, complete_dates)
        if donor is not None:
            donor_eur, donor_fx, _ok = raw[donor]
            # Pair the borrowed EUR value with the rate it was struck at so the
            # USD line still cancels to native USD; keep this day's own rate only
            # as a last resort when the donor had none.
            out[session_date] = (donor_eur, donor_fx if donor_fx is not None else fx)
        elif live_fallback is not None:
            live_eur, live_fx = live_fallback
            out[session_date] = (live_eur, live_fx if live_fx is not None else fx)
        else:
            # No complete day and no live fallback to lean on — keep the raw
            # (possibly zero) value rather than invent one.
            out[session_date] = (nav_eur, fx)
    return out


def _intraday_sleeve_complete(positions: list[Position]) -> bool:
    """Whether *every* held intraday-priced holding could be valued this instant.

    A live capture must reflect the **whole** intraday sleeve. When the app has
    only partly loaded — e.g. the user just opened/logged in and not every
    price (or its FX rate) has arrived yet — one or more holdings carry no usable
    value (``value_warning``: no price sourced, a zero value, or no FX rate).
    Recording then would store a sample that silently *omits* that holding and so
    punch a spurious dip/spike into the curve at that timestamp. Returns ``False``
    in that case so the caller drops the sample and lets a later, fully-loaded
    refresh recapture the instant cleanly. An empty sleeve is trivially complete.
    """
    return all(
        not p.value_warning and p.current_price_native is not None and p.current_price_native > 0
        for p in positions
        if p.shares > _MIN_SHARES and is_intraday_priced(p)
    )


def _intraday_sleeve_fresh(session: Session, positions: list[Position], session_date: date) -> bool:
    """Whether every held intraday-priced holding is priced *at the current session*.

    A live sample must value the **whole** intraday sleeve at one consistent
    instant. A holding whose newest cached close predates the current trading
    session carries an **outdated** price — the refresh failed to land today's bar
    for it (rate-limited, deferred, or the provider stalled on that one symbol),
    so it is still showing a previous session's price while the rest of the sleeve
    has moved on. Folding it into the sample would blend that stale price with the
    live ones, so the stored value misrepresents the portfolio at that timestamp.
    Returns ``False`` then so the caller drops the *entire* sample and waits until
    that holding's price for the session is recovered, rather than recording a
    portfolio value that silently mixes timestamps. An empty sleeve is trivially
    fresh.

    Complements :func:`_intraday_sleeve_complete`: that guard catches a holding
    with *no* usable price/FX yet (still loading); this one catches a holding that
    *has* a price but one stamped to an earlier session than the live capture.
    """
    intraday_ids = [
        p.instrument.id for p in positions if p.shares > _MIN_SHARES and is_intraday_priced(p)
    ]
    if not intraday_ids:
        return True
    from investment_dashboard.services import prices_service  # noqa: PLC0415

    price_dates = prices_service.latest_price_dates_for(session, intraday_ids)
    return all(
        (as_of := price_dates.get(iid)) is not None and as_of >= session_date
        for iid in intraday_ids
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


def _session_open_utc(session_date: date) -> datetime:
    """Naive-UTC instant of the regular-session open (09:30 ET) on ``session_date``."""
    open_local = datetime.combine(session_date, _MARKET_OPEN, tzinfo=_MARKET_TZ)
    return open_local.astimezone(UTC).replace(tzinfo=None)


def _session_close_utc(session_date: date) -> datetime:
    """Naive-UTC instant of the regular-session close (16:00 ET) on ``session_date``."""
    return regular_session_close(session_date).astimezone(UTC).replace(tzinfo=None)


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
    ``False`` when the market is closed, the dedupe floor suppressed it, the
    intraday sleeve was still loading (some holding lacked a price/FX rate, so a
    sample then would omit it and spike the curve — see
    :func:`_intraday_sleeve_complete`), or a holding's price was **outdated** —
    stamped to an earlier session than this capture (see
    :func:`_intraday_sleeve_fresh`), so the whole portfolio value is dropped until
    that holding's current-session price is recovered. Opens its own sessions (it
    runs from the background refresh thread) and never raises — a capture failure
    must never break a price refresh.
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
            # Guard against a partly-loaded portfolio (e.g. the user just opened
            # the app and not every price/FX rate has arrived): a sample that
            # silently omits a still-loading holding would punch a spurious
            # dip/spike into the curve. Drop it and let a later, complete refresh
            # recapture this instant cleanly.
            if not _intraday_sleeve_complete(positions):
                return False
            # Guard against an *outdated* holding price: if any intraday-priced
            # holding is still showing a previous session's close (its today bar
            # failed to land — rate-limited/deferred/provider stalled), the total
            # would blend a stale price with the live ones. Ignore the whole
            # portfolio value until that holding's current-session price recovers.
            if not _intraday_sleeve_fresh(session, positions, last_session_date(now)):
                return False
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
    log.debug(
        "intraday capture @ %s: market-component €%s (fx EUR/USD=%s)",
        captured_at,
        value_eur,
        fx_eur_usd,
    )
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


def session_close_fx(session: Session, *, now: datetime | None = None) -> Decimal | None:
    """The EUR→USD rate (USD per 1 EUR) struck at the most recent session's close.

    Intraday samples are captured *only while the US market is open*
    (:func:`record_if_market_open`), each stamped with the live EUR/USD spot at
    that instant. The newest sample of the current "Day" session therefore carries
    the rate as the session settled — the **session-close FX** the live 1D/1W
    curves freeze their EUR view to overnight so their market-day trajectory does
    not slide with after-hours FX (see
    :mod:`investment_dashboard.domain.session_fx`).

    Returns the latest non-null rate among the session's samples, or ``None`` when
    no session sample carries a rate yet (the freeze then degrades to the live
    spot). Reads only the cached samples — no network.
    """
    samples = day_series_with_fx(session, now=now)
    for _at, _market_eur, fx in reversed(samples):
        if fx is not None and fx > 0:
            return fx
    return None


def session_open_fx(session: Session, *, now: datetime | None = None) -> Decimal | None:
    """The EUR→USD rate (USD per 1 EUR) struck around the current session's **open**.

    The mirror of :func:`session_close_fx`: intraday samples are captured *only
    while the US market is open* (:func:`record_if_market_open`), each stamped with
    the live EUR/USD spot at that instant, so the **oldest** sample of the current
    "Day" session carries the rate roughly as the session opened. This is the
    market-open FX anchor the Overview measures the live market-hours currency
    slice from while the session is running (so last night's overnight slice can be
    carved out as the remainder and survive the market start; see
    :mod:`investment_dashboard.domain.session_fx`).

    Returns the earliest non-null rate among the session's samples, or ``None``
    when no session sample carries a rate yet. Reads only the cached samples — no
    network.
    """
    samples = day_series_with_fx(session, now=now)
    for _at, _market_eur, fx in samples:
        if fx is not None and fx > 0:
            return fx
    return None


def _market_component_pivot_eur(
    priced: list[Position],
    price_lookups: dict[str, Callable[[datetime], Decimal | None]],
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

    ``price_lookups`` maps each symbol to a forward-fill closure built once via
    :func:`_make_forward_fill`, so repricing many instants never re-sorts a
    symbol's bars per point.
    """
    market = Decimal(0)
    for p in priced:
        lookup = price_lookups.get(p.instrument.symbol)
        price_t = lookup(at) if lookup is not None else None
        if price_t is None or price_t <= 0:
            price_t = p.current_price_native
        ratio = price_t / p.current_price_native  # type: ignore[operator]
        contrib = p.current_value_eur * ratio
        if fx_t and base_fx and _is_usd_native(p):
            contrib = contrib * base_fx / fx_t
        market += contrib
    return market


def _make_forward_fill(
    bars: dict[datetime, Decimal],
) -> Callable[[datetime], Decimal | None]:
    """Build a forward-fill lookup over ``bars`` that sorts the keys only once.

    Returns a closure mapping an instant to the latest bar value at or just before
    it (or the earliest bar when every bar is later), via binary search — matching
    :func:`_forward_filled` exactly but without re-sorting on every call, so a hot
    loop repricing many instants over the same bars stays cheap.
    """
    if not bars:
        return lambda _at: None
    times = sorted(bars)
    values = [bars[t] for t in times]

    def lookup(at: datetime) -> Decimal | None:
        idx = bisect_right(times, at)
        return values[idx - 1] if idx else values[0]

    return lookup


def _forward_filled(bars: dict[datetime, Decimal], at: datetime) -> Decimal | None:
    """Latest bar value at/just-before ``at`` (or the earliest, if all later).

    Convenience wrapper over :func:`_make_forward_fill` for a single lookup; hot
    loops should build the closure once and reuse it instead.
    """
    return _make_forward_fill(bars)(at)


def reconstruct_last_session(
    session: Session,
    *,
    now: datetime | None = None,
    force: bool = False,
    fetcher: object | None = None,
    fx_fetcher: object | None = None,
    fx_fallback_fetcher: object | None = None,
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
    ``fetcher`` / ``fx_fetcher`` override the intraday price / FX sources in tests;
    ``fx_fallback_fetcher`` overrides the budget-gated Tiingo intraday-FX backup
    consulted (yfinance-first) when the primary FX feed serves nothing.
    """
    now = now or datetime.now(UTC)
    session_date = last_session_date(now)
    with _reconstruct_lock:
        # Skip the network fetch only once the session is *adequately covered*.
        # The per-session marker alone is not enough, and neither is a mere
        # presence test: a first attempt that wrote nothing — or only a stray bar
        # before the feed stalled / before the rest of the day's bars published —
        # would otherwise pin a gappy curve for the rest of the session (it is
        # never retried). Re-running while the session is under-covered means the
        # last market day always fills in, no matter when the app is opened (e.g.
        # before the next session's open) or how the prior fetch fared. A portfolio
        # with no intraday-priced holdings still short-circuits cheaply inside
        # ``_reconstruct_session`` (before any network call), so this never spams
        # the feed for a genuinely empty day.
        if (
            not force
            and _already_reconstructed(session, session_date)
            and _session_is_covered(session, session_date, now)
        ):
            return 0
        try:
            written = _reconstruct_session(
                session,
                session_date,
                fetcher=fetcher,
                fx_fetcher=fx_fetcher,
                fx_fallback_fetcher=fx_fallback_fetcher,
            )
        except Exception:  # pragma: no cover - defensive: best-effort backfill
            log.warning("intraday session reconstruction failed", exc_info=True)
            return 0
        # Mark the attempt done either way so a holiday / empty day doesn't
        # re-hit the network on every page load; ``force`` bypasses the guard.
        _mark_reconstructed(session, session_date)
        log.info(
            "intraday reconstruct for %s: backfilled %d point(s) (force=%s)",
            session_date,
            written,
            force,
        )
        return written


def _intraday_fx_fallback(
    start_day: date,
    end_day: date,
    *,
    interval: str,
    injected: object | None,
    allow_default: bool,
) -> dict[datetime, Decimal]:
    """Best-effort secondary intraday EUR/USD bars to fill a yfinance FX gap.

    Engaged only after the keyless yfinance intraday feed returned nothing, so
    yfinance is always tried first. ``injected`` overrides the source in tests;
    otherwise the real budget-gated Tiingo secondary
    (:func:`fx_service.intraday_fx_bars_via_tiingo`) runs only on the production
    path (``allow_default`` — i.e. the caller didn't inject its own FX fetcher),
    so a test wiring a fake ``fx_fetcher`` never reaches for a token / keyring or
    the network. These are *historical* last-session bars, never a live weekend
    spot, so the fallback is valid even while the spot-FX market is shut.
    """
    if injected is not None:
        try:
            bars = injected(start_day, end_day, interval=interval)  # type: ignore[operator]
        except Exception:  # pragma: no cover - defensive: best-effort overlay
            log.warning("injected intraday FX fallback failed", exc_info=True)
            return {}
        return dict(bars) if bars else {}
    if not allow_default:
        return {}
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    return fx_service.intraday_fx_bars_via_tiingo(start_day, end_day, interval=interval)


def _reconstruct_session(
    session: Session,
    session_date: date,
    *,
    fetcher: object | None,
    fx_fetcher: object | None = None,
    fx_fallback_fetcher: object | None = None,
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
        if not fx_bars:
            # yfinance served no intraday FX (outage / a quiet weekend row): let the
            # budget-gated Tiingo secondary fill the *historical* last-session rate.
            # yfinance always runs first; this never fires a live weekend spot.
            fx_bars = _intraday_fx_fallback(
                session_date,
                session_date,
                interval=RECONSTRUCT_INTERVAL,
                injected=fx_fallback_fetcher,
                allow_default=fx_fetcher is None,
            )

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
    # Build each forward-fill lookup once (sorts per symbol a single time) so the
    # per-instant repricing below never re-sorts a symbol's bars per point.
    price_lookups = {sym: _make_forward_fill(bars) for sym, bars in bars_by_symbol.items()}
    fx_lookup = _make_forward_fill(fx_bars)
    with cache_write_session(session) as cache:
        for t in bar_times:
            if _covered_by_live(live_times, t):
                continue
            # The rate struck at this minute (forward-filled), or the day's
            # settled spot when no intraday FX is available.
            fx_t = fx_lookup(t) if fx_bars else None
            point_fx = fx_t or base_fx
            # The intraday-priced (market) component only — the cash + NAV base is
            # reapplied at render time, keeping reconstruction on the same basis
            # as the live captures.
            market = _market_component_pivot_eur(
                priced, price_lookups, t, fx_t=fx_t, base_fx=base_fx
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


def _session_is_covered(session: Session, session_date: date, now: datetime) -> bool:
    """Whether the stored "1 Day" samples *adequately cover* ``session_date``.

    A coverage test, not a mere presence test. Used to decide whether a
    reconstruction marked "done" can be trusted: a prior attempt that landed
    nothing, a single stray bar, or only the morning before the feed stalled
    leaves the curve gappy yet would pass an "any sample exists" check and pin the
    done-marker for the rest of the session (it is never retried). The session is
    judged covered only when the stored samples all hold:

    * at least :data:`RECONSTRUCT_MIN_COVERAGE_SAMPLES` points;
    * a first→last span of at least :data:`RECONSTRUCT_COVERAGE_FRACTION` of the
      session elapsed so far (catches a morning-only / trailing-stalled curve); and
    * no *internal hole* — neither the gap from the open to the first sample nor
      any gap between consecutive samples exceeds :data:`RECONSTRUCT_MAX_GAP_SECONDS`
      (catches a midday stall the span test cannot see, where captures stopped and
      later resumed, leaving a flat straight line across the gap).

    Any failure re-pulls to fill the gaps (cheap — yfinance is unmetered). The
    next render's reconstruction lays its 15-min grid across the hole, after which
    the session reads as covered and the re-pulling stops.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    start = _session_start_utc(session_date)
    end = _session_start_utc(session_date + timedelta(days=1))
    with cache_read_session(session) as cache:
        times = sorted(r.captured_at for r in intraday_repo.list_in_range(cache, start, end))
    if len(times) < RECONSTRUCT_MIN_COVERAGE_SAMPLES:
        return False
    open_utc = _session_open_utc(session_date)
    elapsed_end = min(_to_naive_utc(now), _session_close_utc(session_date))
    expected_span = (elapsed_end - open_utc).total_seconds()
    if expected_span <= 0:
        # Before the open there is no span to require; any stored samples suffice.
        return True
    actual_span = (times[-1] - times[0]).total_seconds()
    if Decimal(actual_span) < RECONSTRUCT_COVERAGE_FRACTION * Decimal(expected_span):
        return False
    # No internal hole: measure the open→first gap and every consecutive gap so an
    # early premarket point can't mask a missing morning. A hole wider than the
    # tolerance means data is missing mid-session, so re-pull to fill it.
    return _max_gap_seconds([open_utc, *times]) <= RECONSTRUCT_MAX_GAP_SECONDS


def _max_gap_seconds(times: list[datetime]) -> float:
    """Largest gap (seconds) between consecutive instants in ``times`` (sorted).

    ``0`` for fewer than two instants. Used to spot an internal hole in an
    otherwise well-spanned "1 Day" curve — the span test only sees first→last.
    """
    ordered = sorted(times)
    if len(ordered) < 2:
        return 0.0
    return max((b - a).total_seconds() for a, b in pairwise(ordered))


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


def _pick_session_points(bar_times: list[datetime]) -> list[datetime]:
    """Return a day's bar instants to plot — *all* of them, chronologically.

    The week curve is sourced at :data:`WEEK_INTERVAL` (30-minute) bars with no
    token/credit limit, so every sourced bar is kept rather than thinned to a few
    representative points: a full trading day yields ~13 genuine 30-minute marks,
    giving the curve its real intraday shape instead of a coarse five-point step.
    De-duplicates and sorts defensively; the open and close stay exact as the
    first and last instants.
    """
    return sorted(set(bar_times))


def _week_day_is_covered(
    session_date: date,
    anchor: date,
    now: datetime,
    sample_times: list[datetime],
) -> bool:
    """Whether ``session_date``'s cached "1 Week" samples adequately cover it.

    Pure predicate over the day's stored sample instants (``sample_times``), so
    both the cache-first fetcher (:func:`week_series_with_fx`) and the read-only
    data-health probe (:func:`assess_graph_coverage`) judge "below target" the
    same way:

    * the in-progress *anchor* session is exempt — its close hasn't happened yet
      and it grows from today's dense live captures, so any sample counts; and
    * a *finished* session must carry the full representative span: at least
      :data:`WEEK_POINTS_PER_COMPLETE_SESSION` points *and* a first→last reach
      across at least :data:`WEEK_COVERAGE_FRACTION` of the open→close session.

    Too few points — or points all clustered in one stretch — means the day is
    below target (data is missing), so it reports uncovered to trigger a re-pull.
    """
    if not sample_times:
        return False
    if session_date == anchor and _to_naive_utc(now) <= _session_close_utc(session_date):
        return True
    if len(sample_times) < WEEK_POINTS_PER_COMPLETE_SESSION:
        return False
    open_utc = _session_open_utc(session_date)
    session_span = (_session_close_utc(session_date) - open_utc).total_seconds()
    if session_span <= 0:
        return True
    actual_span = (sample_times[-1] - sample_times[0]).total_seconds()
    return Decimal(actual_span) >= WEEK_COVERAGE_FRACTION * Decimal(session_span)


def week_series_with_fx(
    session: Session,
    *,
    now: datetime | None = None,
    force: bool = False,
    fetcher: object | None = None,
    fx_fetcher: object | None = None,
    fx_fallback_fetcher: object | None = None,
    interval: str = WEEK_INTERVAL,
) -> list[tuple[datetime, Decimal, Decimal | None]]:
    """All sourced 30-minute market-component samples over the week.

    Returns ``[(at_utc, market_value_eur, fx_eur_usd), ...]`` (oldest first) — the
    same shape as :func:`day_series_with_fx`, so the render path
    (:func:`build_week_value_series`) can reapply the cash + NAV base and convert
    to either currency with the identical per-minute FX model used by the "1 Day"
    curve. USD stays FX-free (booked currency); EUR is derived at each bar's own
    EUR/USD rate, so the two currency lines genuinely diverge across the week.

    Each session is repriced against *that day's* held positions (so a buy or
    sell mid-week is reflected), keeping *every* sourced 30-minute bar (~13/day)
    so the curve carries each day's full intraday shape.

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

    ``force`` bypasses the per-session fetched-day guard so every uncovered day
    is re-pulled even if it was already attempted this anchor session — used by
    the historic re-download (e.g. after a cache reset), where the intraday
    samples are wiped but the ``app_config`` markers survive, which would
    otherwise leave the "1 Week" curve empty until the next anchor session.

    ``interval`` overrides the bar width used to reconstruct *gap* days (default
    :data:`WEEK_INTERVAL`); the centralized data export passes its configurable
    grid (e.g. ``"15m"``) so the blob's market-sleeve backbone can be denser.

    ``fx_fetcher`` overrides the primary (yfinance) intraday EUR/USD source and
    ``fx_fallback_fetcher`` the budget-gated Tiingo secondary consulted
    (yfinance-first) when that primary serves nothing — both for tests.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    now = now or datetime.now(UTC)
    # `sessions` are NYSE session dates (ET) from `recent_trading_sessions` →
    # `last_session_date`, which resolves "today" in exchange time and rolls back
    # over weekends/holidays. So the week window — `sessions[0]` (oldest, the
    # prev-close/start anchor) through `sessions[-1]` (the live anchor) — is
    # already on the one ET clock the export and web companion share
    # (`docs/time_alignment_plan.md`); do not regress it to a local-date picker.
    sessions = recent_trading_sessions(now)
    if not sessions:
        return []
    anchor = sessions[-1]
    week_start = _session_start_utc(sessions[0])
    window_end = min(_to_naive_utc(now), _session_start_utc(sessions[-1] + timedelta(days=1)))

    # 1. Cache first — the rolling week already on hand. A *completed* (earlier)
    #    session is covered only once it holds at least
    #    :data:`WEEK_POINTS_PER_COMPLETE_SESSION` points, so a partial earlier
    #    fetch or a single stray live capture no longer freezes a day at an
    #    incomplete curve — it is re-pulled to fill the gaps. The current/anchor
    #    session is exempt: its close may not have happened yet and it grows from
    #    today's dense live captures, so any sample counts and it is never
    #    re-downloaded (those live points are denser than a coarse re-fetch and
    #    must be preserved).
    with cache_read_session(session) as cache:
        cached = [
            (r.captured_at, r.market_value_eur, r.fx_eur_usd)
            for r in intraday_repo.list_in_range(cache, week_start, window_end)
        ]

    def _is_covered(session_date: date) -> bool:
        start = _session_start_utc(session_date)
        end = _session_start_utc(session_date + timedelta(days=1))
        sample_times = sorted(at for at, _, _ in cached if start <= at < end)
        return _week_day_is_covered(session_date, anchor, now, sample_times)

    # 2. Fetch only the gaps, and only days not already attempted this session
    #    (``force`` re-pulls every uncovered day regardless of the marker).
    to_fetch = [
        d
        for d in sessions
        if not _is_covered(d) and (force or not _week_day_fetched(session, d, anchor))
    ]

    fetched: list[tuple[datetime, Decimal, Decimal | None]] = []
    if to_fetch:
        fetched = _fetch_and_persist_week_days(
            session,
            to_fetch,
            anchor,
            week_start,
            fetcher=fetcher,
            fx_fetcher=fx_fetcher,
            fx_fallback_fetcher=fx_fallback_fetcher,
            interval=interval,
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
    """All 30-minute market-component samples for one session day."""
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
    # Build each forward-fill lookup once so repricing every 30-minute instant
    # below never re-sorts a symbol's bars per point.
    price_lookups = {sym: _make_forward_fill(bars) for sym, bars in bars_by_symbol.items()}
    fx_lookup = _make_forward_fill(fx_bars)
    samples: list[tuple[datetime, Decimal, Decimal | None]] = []
    for t in _pick_session_points(day_bar_times):
        fx_t = fx_lookup(t) if fx_bars else None
        point_fx = fx_t or base_fx
        market = _market_component_pivot_eur(priced, price_lookups, t, fx_t=fx_t, base_fx=base_fx)
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
    fx_fallback_fetcher: object | None = None,
    interval: str = WEEK_INTERVAL,
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
                symbols, to_fetch[0], to_fetch[-1], interval=interval
            )
        except Exception:  # pragma: no cover - defensive: best-effort network fetch
            log.warning("week curve intraday fetch failed", exc_info=True)
            bars_by_symbol = {}

        fx_bars: dict[datetime, Decimal] = {}
        if needs_fx and bars_by_symbol:
            fx_fetch = fx_fetcher or yfinance_client.fetch_eur_usd_intraday_range
            try:
                fx_bars = fx_fetch(to_fetch[0], to_fetch[-1], interval=interval)  # type: ignore[operator]
            except Exception:  # pragma: no cover - defensive: FX overlay is best-effort
                log.warning("week curve EUR/USD fetch failed", exc_info=True)
                fx_bars = {}
            if not fx_bars:
                # yfinance served no intraday FX over the window: let the budget-gated
                # Tiingo secondary fill the *historical* per-minute rates (yfinance
                # first; never a live weekend spot).
                fx_bars = _intraday_fx_fallback(
                    to_fetch[0],
                    to_fetch[-1],
                    interval=interval,
                    injected=fx_fallback_fetcher,
                    allow_default=fx_fetcher is None,
                )

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


@dataclass(frozen=True)
class GraphCoverage:
    """Read-only verdict on whether the live intraday graphs reached target.

    ``day_below_target`` is set when the "1 Day" session has *finished* yet its
    stored curve never reached the coverage target (so it can no longer fill).
    ``week_days_below_target`` lists the finished "1 Week" sessions still short of
    their representative span. Both ignore the *in-progress* session, which is
    expected to still be filling, and any day on which nothing intraday is held
    (there is nothing to plot, so it is vacuously covered).
    """

    day_below_target: bool
    week_days_below_target: tuple[date, ...]

    @property
    def has_gaps(self) -> bool:
        return self.day_below_target or bool(self.week_days_below_target)


def assess_graph_coverage(session: Session, *, now: datetime | None = None) -> GraphCoverage:
    """Report which live intraday graphs are below target — read-only, no network.

    Mirrors the coverage predicates the backfill itself uses
    (:func:`_session_is_covered` for "1 Day", :func:`_week_day_is_covered` for
    "1 Week") so the Data Health surface flags exactly the days the backfill tried
    yet could not fill. Only *finished* sessions on which intraday-priced holdings
    were actually held are considered, so an in-progress (still-filling) session
    or a day with nothing to plot never raises a false alarm. Performs no network
    calls and writes nothing, so it is safe to call on every Data Health render.
    """
    from investment_dashboard.db import cache_read_session  # noqa: PLC0415

    now = now or datetime.now(UTC)
    now_naive = _to_naive_utc(now)

    # "1 Day": flag only once the session has closed and still fell short — while
    # it is open the reconstruction is expected to keep filling it.
    day = last_session_date(now)
    day_below_target = (
        now_naive > _session_close_utc(day)
        and bool(_priced_intraday_positions(session, day))
        and not _session_is_covered(session, day, now)
    )

    # "1 Week": each finished, held session that never reached its span target.
    # The in-progress *anchor* session is excluded here — it is still filling and
    # its coverage is represented by the "1 Day" check above, so it is never
    # double-flagged or flagged early.
    sessions = recent_trading_sessions(now)
    anchor = sessions[-1]
    finished_sessions = sessions[:-1]
    week_start = _session_start_utc(sessions[0])
    window_end = min(now_naive, _session_start_utc(sessions[-1] + timedelta(days=1)))
    with cache_read_session(session) as cache:
        cached_times = [
            r.captured_at for r in intraday_repo.list_in_range(cache, week_start, window_end)
        ]

    week_gaps: list[date] = []
    for session_date in finished_sessions:
        if not _priced_intraday_positions(session, session_date):
            continue
        start = _session_start_utc(session_date)
        end = _session_start_utc(session_date + timedelta(days=1))
        sample_times = sorted(t for t in cached_times if start <= t < end)
        if not _week_day_is_covered(session_date, anchor, now, sample_times):
            week_gaps.append(session_date)

    return GraphCoverage(day_below_target=day_below_target, week_days_below_target=tuple(week_gaps))


def backfill_graphs(*, now: datetime | None = None) -> GraphCoverage:
    """Top up the live "1 Day" + "1 Week" graphs to target — every auto-update.

    Run from the background refresh tick (see
    :func:`investment_dashboard.services.auto_refresh.tick_refresh`) so an
    under-filled graph keeps trying to complete on *every* auto-update,
    regardless of whether the US market is currently open — unlike the live
    capture, which only appends a point while the market trades. Both fills are
    cache-first and self-limiting (a fully-covered graph is a no-op):

    * **1 Day** — :func:`reconstruct_last_session` re-pulls the last session only
      while it is under-covered, laying its 15-minute grid across any gap.
    * **1 Week** — :func:`week_series_with_fx` with ``force=True`` re-attempts the
      uncovered sessions each tick (bypassing the once-per-anchor render guard,
      which exists only to keep page renders off the network), so a day that came
      up short keeps being topped up rather than frozen until the next restart.

    Returns the resulting :class:`GraphCoverage` so the caller can flag a graph
    that still could not be filled. Best-effort: opens its own session and never
    raises — a backfill failure must never break a price refresh.
    """
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415

    now = now or datetime.now(UTC)
    try:
        with ledger_session_scope() as session:
            reconstruct_last_session(session, now=now)
            week_series_with_fx(session, now=now, force=True)
            coverage = assess_graph_coverage(session, now=now)
        if coverage.has_gaps:
            log.info(
                "intraday graph still below target after backfill "
                "(1 Day=%s, 1 Week gaps=%s) — surfaced in Data Health",
                coverage.day_below_target,
                [d.isoformat() for d in coverage.week_days_below_target],
            )
        return coverage
    except Exception:  # pragma: no cover - defensive: backfill is best-effort
        log.warning("intraday graph backfill failed", exc_info=True)
        return GraphCoverage(day_below_target=False, week_days_below_target=())
