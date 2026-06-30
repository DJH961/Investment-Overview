"""Query helpers for ``/overview`` — KPI quartet + position rows + treemap data."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta, tzinfo
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain.currency import (
    dual_currency_amounts,
    lookup_rate_with_forward_fill,
)
from investment_dashboard.domain.market_hours import (
    feed_is_fresh,
    is_trading_day,
    is_us_market_open,
    latest_settled_session_date,
)
from investment_dashboard.domain.money_market import is_money_market
from investment_dashboard.domain.returns import (
    total_growth_pct_compounded,
    xirr,
    years_between,
)
from investment_dashboard.domain.session_fx import graph_anchor_fx
from investment_dashboard.models import TransactionKind
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import (
    chart_prefs_service,
    fx_service,
    intraday_snapshots_service,
    prices_service,
    snapshots_service,
)
from investment_dashboard.services.metrics_service import (
    PortfolioMetrics,
    build_instrument_cashflows,
    compute_portfolio_metrics,
)
from investment_dashboard.services.positions_service import (
    Position,
    compute_positions,
    total_portfolio_value,
)
from investment_dashboard.ui.money_format import currency_symbol, fmt_shares

ZERO = Decimal(0)
_CENT = Decimal("0.01")

#: Time-range options for the Overview value-over-time chart. ``None`` means a
#: non-fixed lookback (``"All"`` starts at the first transaction; ``"YTD"`` starts
#: at 1 January of the current year — both resolved at build time, see
#: :func:`range_start_date`). Labels match the user's requested
#: Day / Week / Month / YTD / Year / All selections.
VALUE_RANGES: tuple[tuple[str, int | None], ...] = (
    ("Day", 1),
    ("Week", 7),
    ("Month", 30),
    ("YTD", None),
    ("Year", 365),
    ("All", None),
)
_DEFAULT_RANGE = "Year"

#: Ranges that render the multi-currency comparison chart. Every range carries
#: the other-currency comparison line, including the intraday "Day" curve (which
#: keeps its own previous-close reference styling on top of the companion line).
MULTI_CCY_RANGES: frozenset[str] = frozenset({"Day", "Week", "Month", "YTD", "Year", "All"})


@dataclass(frozen=True)
class ValueSeriesPoint:
    """One point on the Overview portfolio-value line graph."""

    date: date
    value: Decimal


def resolve_range_days(label: str | None) -> tuple[str, int | None]:
    """Map a range query-param to ``(canonical_label, lookback_days|None)``.

    Matching is case-insensitive against the canonical :data:`VALUE_RANGES`
    labels (so ``"ytd"`` resolves to ``"YTD"``). ``None`` lookback days are used
    by ``"All"`` and ``"YTD"``, whose start dates are resolved at build time by
    :func:`range_start_date`.
    """
    if label is not None:
        wanted = label.strip().casefold()
        for name, days in VALUE_RANGES:
            if name.casefold() == wanted:
                return name, days
    for name, days in VALUE_RANGES:
        if name == _DEFAULT_RANGE:
            return name, days
    return VALUE_RANGES[0]


#: Sticky range used *outside* market hours (the historical pref key — kept so
#: an existing standard selection migrates seamlessly).
_RANGE_STANDARD_KEY = "overview_value_range"

#: Range used *during* a market session, plus the session date it was set for so
#: a stored choice only counts for the session it was made in (the next session
#: opens on Day again without us actively clearing anything overnight).
_RANGE_MARKET_KEY = "overview_value_range_market"
_RANGE_MARKET_SESSION_KEY = "overview_value_range_market_session"

#: The range the market view always opens on at the start of a session.
_RANGE_MARKET_DEFAULT = "Day"


def _range_allowed() -> list[str]:
    return [name for name, _ in VALUE_RANGES]


def _range_session_token(now: datetime | None) -> str:
    return intraday_snapshots_service.last_session_date(now).isoformat()


def effective_overview_range(session: Session, *, now: datetime | None = None) -> str:
    """Canonical range label the Overview should lead with right now.

    Layers a market-hours-aware behaviour over the plain sticky toggle so the
    page shows the live intraday "Day" curve exactly when it is interesting:

    * **Market open** → the *market* selection, reset to ``Day`` at the start of
      every session (and whenever the app is first opened mid-session), but
      remembering a manual mid-session switch until the close.
    * **Market closed** → the *standard* selection — whatever the user last had
      outside trading hours (untouched while the market was open).
    """
    if is_us_market_open(now):
        stored_session = chart_prefs_service.get_pref(
            session, _RANGE_MARKET_SESSION_KEY, default=""
        )
        if stored_session != _range_session_token(now):
            # A fresh (or not-yet-touched) session always opens on Day.
            return _RANGE_MARKET_DEFAULT
        return chart_prefs_service.get_pref(
            session, _RANGE_MARKET_KEY, default=_RANGE_MARKET_DEFAULT, allowed=_range_allowed()
        )
    return chart_prefs_service.get_pref(
        session, _RANGE_STANDARD_KEY, default=resolve_range_days(None)[0], allowed=_range_allowed()
    )


def remember_overview_range(session: Session, label: str, *, now: datetime | None = None) -> None:
    """Persist a manual range change against the relevant selection.

    During market hours the choice updates the *market* selection (stamped with
    the current session so it resets next session); outside market hours it
    updates the sticky *standard* selection.
    """
    if is_us_market_open(now):
        chart_prefs_service.set_pref(session, _RANGE_MARKET_KEY, label)
        chart_prefs_service.set_pref(session, _RANGE_MARKET_SESSION_KEY, _range_session_token(now))
    else:
        chart_prefs_service.set_pref(session, _RANGE_STANDARD_KEY, label)


def _earliest_transaction_date(session: Session) -> date | None:
    txns = transactions_repo.list_transactions(session)
    return txns[0].date if txns else None


def range_start_date(session: Session, range_label: str | None, end: date) -> date | None:
    """Resolve the inclusive start date for ``range_label`` ending at ``end``.

    * ``"YTD"`` → 1 January of ``end``'s year.
    * ``"All"`` (and any ``None`` lookback) → the first transaction date, or
      ``None`` when the ledger is empty (nothing to plot).
    * A fixed lookback (Week/Month/Year/…) → ``end - days``.

    The returned date is clamped to be no later than ``end``.
    """
    canon, days = resolve_range_days(range_label)
    if canon == "YTD":
        start = date(end.year, 1, 1)
    elif days is None:
        start = _earliest_transaction_date(session)
        if start is None:
            return None
    else:
        start = end - timedelta(days=days)
    return min(start, end)


def build_value_series(
    session: Session,
    *,
    currency: str,
    range_label: str | None = None,
    as_of: date | None = None,
    recompute_tail_days: int | None = None,
) -> list[ValueSeriesPoint]:
    """Daily portfolio-value series for the selected range, in ``currency``.

    Uses the read-through snapshot cache, so historical days are O(1) and —
    now that historical valuations price with the as-of close (v2.8 item 1) —
    the curve reflects how the portfolio actually moved rather than today's
    prices projected backwards. Returns ``[]`` when there is no history.

    ``recompute_tail_days`` is forwarded to
    :func:`snapshots_service.series_in_currency` to bound how many uncached
    historical days are recomputed on the request thread. The full-history
    Yearly chart passes a small value so it renders straight from the persistent
    snapshot cache (plus a few fresh recent days) instead of cold-rebuilding the
    whole daily curve synchronously — which used to block the event loop long
    enough to trip NiceGUI's reconnect window and "crash" the app.
    """
    end = as_of or date.today()
    start = range_start_date(session, range_label, end)
    if start is None:
        return []

    points = [
        ValueSeriesPoint(date=day, value=value)
        for day, value in snapshots_service.series_in_currency(
            session, start, end, currency, recompute_tail_days=recompute_tail_days
        )
    ]
    if not points:
        return points
    # Drop non-trading days (weekends / NYSE holidays). On those days the value
    # is just the prior session's settled close carried forward, so plotting
    # them only adds flat steps that repeat the day before; the line's own
    # smoothing bridges the gap far more cleanly. When *today* is itself a
    # non-trading day (e.g. the app is opened over a weekend) we deliberately do
    # NOT tack the carried-forward value onto a non-trading "today": the curve
    # simply ends a day or two early at the last real session, whose settled
    # close is the correct final price from the last market day.
    trading = [p for p in points if is_trading_day(p.date)]
    if trading:
        return trading
    # Degenerate window with no trading day at all (e.g. a brand-new book first
    # opened over a weekend) — keep the points so the chart is never empty.
    return points


def build_window_value_series(
    session: Session,
    *,
    currency: str,
    sessions: int,
    tz: tzinfo | None = None,
    now: datetime | None = None,
    positions: list[Position] | None = None,
    freeze_after_hours: bool = False,
) -> list[ValueSeriesPoint]:
    """One range-parameterized intraday-window value series — the unified builder.

    The Python parity for ``docs/graph-unification-plan.md`` C8: there is no
    separate "1 Day" and "1 Week" code path, only **one intraday-window builder**
    parameterised by how many recent trading sessions it spans. ``sessions <= 1``
    is the within-day "Day" window; ``sessions > 1`` is the multi-session "Week"
    window (its span fixed by :data:`intraday_snapshots_service.WEEK_SESSIONS`).
    Both draw the *same* dense 5-minute per-session reconstruction from the shared
    intraday cache, so the 1-day slice of the week is literally the same points as
    the standalone Day curve, and both share the identical currency model
    (:func:`_compose_currency_points`) and after-hours EUR tip freeze
    (:func:`_freeze_eur_live_tip`).

    See :func:`build_intraday_value_series` for the full currency model (USD native
    and FX-free, EUR derived per-minute) and ``freeze_after_hours`` semantics. The
    only window-dependent differences are:

    * **base decomposition** — the Day window holds every NAV holding flat in the
      base; the multi-session window pulls the *day-drifting* NAV funds out so each
      session can slope at its own dated NAV (see
      :func:`intraday_snapshots_service.week_nav_drift_with_fx`); and
    * **empty-book tip** — only the Day window seeds a lone live tip on a
      brand-new book with no samples yet (the multi-session window needs at least
      one real sourced sample before it caps with the live tip).

    Returns ``[]`` when there is nothing to plot, so the caller can fall back to
    the empty state / the daily snapshot series.
    """
    currency = currency.upper()
    now = now or datetime.now(UTC)

    if positions is None:
        positions = compute_positions(session)
    total_now = total_portfolio_value(session, positions=positions)
    market_now = intraday_snapshots_service.market_value_eur(positions)

    rate: Decimal | None = None
    if currency != "EUR":
        rate = fx_service.get_rate_eur_to_quote(session, date.today(), quote=currency)

    multi_session = sessions > 1
    nav_now = ZERO
    if multi_session:
        # Pull the day-drifting NAV funds out of the flat base so each session can
        # reapply its own dated NAV (sloping per-day) instead of riding flat at
        # today's. ``base`` then keeps only the genuinely constant cash + savings +
        # money-market remainder.
        nav_now = intraday_snapshots_service.nav_drift_value_eur(positions)
        base = total_now - market_now - nav_now
        samples = intraday_snapshots_service.week_series_with_fx(session, now=now)
    else:
        base = total_now - market_now
        samples = intraday_snapshots_service.day_series_with_fx(session, now=now)

    # Cap the curve with the live current value so the tip equals the headline
    # Total Value, pinned to the market close once the session is over (so it
    # doesn't trail a flat line overnight / all weekend). The Day window also
    # seeds a lone tip on a genuinely empty book (no samples and a non-zero live
    # value); the multi-session window requires a real sample first.
    live_at = now.astimezone(UTC).replace(tzinfo=None) if now.tzinfo is not None else now
    live_at = min(live_at, intraday_snapshots_service.session_close_utc(now))
    appended_tip = False
    seed_empty = not multi_session and not samples and total_now != 0
    if seed_empty or (samples and samples[-1][0] < live_at):
        samples = [*samples, (live_at, market_now, rate)]
        appended_tip = True

    if not samples:
        return []

    nav_components: dict[datetime, tuple[Decimal, Decimal | None]] | None = None
    if multi_session:
        # Per-session NAV-fund track, mapped onto each sample by its exchange date,
        # so every point gets the fund sleeve's value *as published that day*
        # rather than today's. Reads only the price cache (no extra network fetch);
        # ``live_fallback`` (today's live NAV value + spot EUR/USD) is a last-resort
        # stand-in for a window day whose NAV/FX hasn't been cached yet, re-derived
        # each render so a later good close/FX pull patches the gap.
        nav_fx_today = fx_service.get_rate_eur_to_quote(session, date.today(), quote="USD")
        nav_by_date = intraday_snapshots_service.week_nav_drift_with_fx(
            session, now=now, live_fallback=(nav_now, nav_fx_today)
        )
        nav_components = {
            at_utc: nav_by_date.get(
                intraday_snapshots_service.session_date_of(at_utc), (ZERO, None)
            )
            for at_utc, _market, _fx in samples
        }

    points = _compose_currency_points(
        samples, base=base, currency=currency, rate=rate, tz=tz, nav_components=nav_components
    )
    if freeze_after_hours and appended_tip:
        points = _freeze_eur_live_tip(session, points, currency=currency, now=now)
    return points


def build_intraday_value_series(
    session: Session,
    *,
    currency: str,
    tz: tzinfo | None = None,
    now: datetime | None = None,
    positions: list[Position] | None = None,
    freeze_after_hours: bool = False,
) -> list[ValueSeriesPoint]:
    """Within-day portfolio-value series for the Overview "Day" range.

    Built from the intraday samples captured during today's market session
    (:mod:`investment_dashboard.services.intraday_snapshots_service`) rather than
    the once-a-day snapshot cache, so the curve shows real intraday movement with
    market-time points only.

    Each stored sample holds just the intraday-priced (market) component; this
    adds back the constant cash + NAV base (cash, mutual funds, money-market
    funds) so the plotted figure is the whole-portfolio value while those
    once-a-day-NAV holdings never enter the intraday variation — a mutual fund's
    post-close revaluation shifts the whole curve uniformly instead of spiking the
    points captured before it, and a part-day-live session joins its reconstructed
    remainder without a step. The live current value is appended as the final
    point so the tip matches the headline figure, and its timestamp is localised
    to ``tz`` for display. ``ValueSeriesPoint.date`` carries a full
    :class:`~datetime.datetime` here (a ``date`` subclass), which the chart
    renders on a time-of-day axis.

    Currency model — USD is native, EUR is derived. USD is the booked currency
    (the stock prices arrive in USD), so the USD "1 Day" line is **FX-free**: it
    is purely price-driven, with no exchange rate applied to the market component.
    The EUR line is the *derived* one — each point's USD market value is converted
    to euros at the EUR/USD rate struck at that very minute (stored with the
    sample). Because every minute's rate is used rather than one uniform spot, the
    EUR line legitimately diverges point-by-point from the USD line as the FX
    market moves through the session. A point whose rate was never recorded falls
    back to today's spot for the EUR conversion.

    (Internally the samples are pivoted in EUR — the app's pivot currency — so a
    mixed/EUR-native portfolio and FX-less test fixtures stay representable in a
    single scalar. The per-minute rate that the EUR pivot was stored at is kept
    alongside, so the native USD value is recovered exactly by removing it; no FX
    is ever *applied* to USD.)

    Returns ``[]`` when there is nothing to plot (no samples *and* no live value
    — e.g. an empty ledger), so the caller can fall back to the empty state.

    ``freeze_after_hours`` freezes the EUR view's **live tip** to the
    session-close FX once the US market has shut, so the 1D market-day trajectory
    does not slide up and down with overnight FX (see
    :mod:`investment_dashboard.domain.session_fx`). It is a no-op while the market
    is open, for the FX-free USD line, or when no close rate is known; the longer
    history ranges deliberately keep the live after-hours rate and so do not pass
    it.

    This is the **window(1 session)** case of the unified
    :func:`build_window_value_series` (``docs/graph-unification-plan.md`` C8).
    """
    return build_window_value_series(
        session,
        currency=currency,
        sessions=1,
        tz=tz,
        now=now,
        positions=positions,
        freeze_after_hours=freeze_after_hours,
    )


def _compose_currency_points(
    samples: list[tuple[datetime, Decimal, Decimal | None]],
    *,
    base: Decimal,
    currency: str,
    rate: Decimal | None,
    tz: tzinfo | None,
    nav_components: dict[datetime, tuple[Decimal, Decimal | None]] | None = None,
) -> list[ValueSeriesPoint]:
    """Turn ``(at_utc, market_eur, fx_eur_usd)`` samples into display-currency points.

    Shared by the intraday "Day" curve and the multi-day "Week" curve. ``base``
    is the constant cash + NAV remainder (EUR); ``market_eur`` is the
    intraday-priced component's EUR pivot at that instant; ``rate`` is today's
    EUR→``currency`` spot used for the EUR-native base. See
    :func:`build_intraday_value_series` for the full currency model — USD is the
    booked currency and stays FX-free, EUR is derived per-minute.

    ``nav_components`` (Week curve only) carries an extra per-sample
    ``(nav_eur, nav_fx)`` — the day-drifting NAV funds revalued at *that* session
    date's own NAV and settled FX — so the fund sleeve slopes per-day instead of
    sitting in the flat ``base``. It is added on the same currency basis as the
    market component (FX-free in USD via that day's own rate; per-day EUR
    otherwise). When ``None`` the base alone carries every NAV holding (the "Day"
    curve, unchanged).
    """
    points: list[ValueSeriesPoint] = []
    no_nav: tuple[Decimal, Decimal | None] = (ZERO, None)
    for at_utc, market_eur, sample_fx in samples:
        nav_eur, nav_fx = (
            nav_components.get(at_utc, no_nav) if nav_components is not None else no_nav
        )
        if currency == "EUR" or not rate:
            # EUR view (derived): the base is already EUR; the market component
            # carries its own per-minute FX in ``market_eur`` (USD-booked holdings
            # were converted to euros at each minute's rate during capture /
            # reconstruction), so the EUR line moves with both price *and* FX. The
            # NAV sleeve adds its own dated EUR value on top.
            value = base + market_eur + nav_eur
        else:
            # USD view (native): USD is the booked currency, so the market
            # component must be FX-free / price-only. The EUR pivot stored it
            # divided by that minute's rate, so multiplying by the *same* rate
            # cancels the FX exactly and recovers the native USD price — no
            # exchange rate is applied to USD. Only the constant cash + NAV base
            # is converted, at today's spot. A sample with no recorded rate falls
            # back to today's spot (FX still cancels for that point).
            point_rate = sample_fx if (sample_fx and currency == "USD") else rate
            # The NAV sleeve cancels with *its* session date's own settled rate
            # (the rate its EUR pivot was struck at), recovering native USD.
            nav_rate = nav_fx if (nav_fx and currency == "USD") else rate
            value = base * rate + market_eur * point_rate + nav_eur * nav_rate
        when: datetime = at_utc
        if tz is not None:
            when = at_utc.replace(tzinfo=UTC).astimezone(tz).replace(tzinfo=None)
        points.append(ValueSeriesPoint(date=when, value=value))
    return points


def _freeze_eur_live_tip(
    session: Session,
    points: list[ValueSeriesPoint],
    *,
    currency: str,
    now: datetime,
) -> list[ValueSeriesPoint]:
    """Re-mark the live tip's EUR value to the session-close FX once the market shuts.

    The 1D / 1W curves draw a *market-day trajectory*, so after the close their
    EUR view must freeze to the rate the session settled at rather than slide with
    after-hours FX (see :mod:`investment_dashboard.domain.session_fx`). Only the
    synthetic **live tip** — the final point, appended at the live spot — needs
    this: every historical sample already stored its own per-minute rate, and USD
    is the booked, FX-free currency so only the EUR line moves on FX.

    The frozen tip is the live tip rescaled by ``live_fx / anchor`` — exactly the
    USD-booked value re-expressed at the freeze rate instead of the live one. The
    freeze rate is the session-close FX (read from the intraday samples), else the
    prior settled session's rate when no sample captured the close (app not live at
    16:00 ET / cold start / weekend), else the live rate. A no-op (returns
    ``points`` unchanged) for the USD line, while the market is open (the anchor
    *is* the live rate), or when no usable freeze rate differs from the live one.
    """
    if currency.upper() != "EUR" or not points:
        return points
    live_fx = fx_service.get_rate_eur_to_quote(session, date.today(), quote="USD")
    close_fx = intraday_snapshots_service.session_close_fx(session, now=now)
    # When no intraday sample captured the close (app not open at 16:00 ET, a cold
    # start, or over a weekend), freeze to the prior settled session's rate — a
    # real, non-drifting anchor — rather than letting the curve slide with the
    # live after-hours spot. Mirrors web's `settledPrevFx` fallback in graphAnchorFx.
    settled_prev_fx: Decimal | None = None
    if close_fx is None:
        eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
        settled_prev_fx = lookup_rate_with_forward_fill(
            eur_to_usd, latest_settled_session_date(now)
        )
    anchor = graph_anchor_fx(
        market_open=is_us_market_open(now),
        live_fx=live_fx,
        session_close_fx=close_fx,
        settled_prev_fx=settled_prev_fx,
    )
    if live_fx is None or live_fx <= 0 or anchor is None or anchor <= 0 or anchor == live_fx:
        return points
    tip = points[-1]
    return [*points[:-1], replace(tip, value=tip.value * live_fx / anchor)]


def build_week_value_series(
    session: Session,
    *,
    currency: str,
    tz: tzinfo | None = None,
    now: datetime | None = None,
    positions: list[Position] | None = None,
    freeze_after_hours: bool = False,
) -> list[ValueSeriesPoint]:
    """Multi-day portfolio-value series for the Overview "Week" (1W) range.

    The same dense intraday curve as the "Day" range, drawn over the last few
    trading sessions instead of one: each session lays down its full set of
    **5-minute** bars — the identical per-session reconstruction the Day curve uses
    (``docs/graph-unification-plan.md`` C8) — so the week reads as a smooth,
    detailed curve and its 1-day slice is identical to the standalone Day curve,
    not merely similar.

    The intraday-priced (market) component at each instant is sourced best-effort
    from the price feed (see
    :func:`intraday_snapshots_service.week_series_with_fx`); the constant cash +
    savings + money-market base is reapplied here exactly as the Day curve does,
    and the same per-minute FX / currency model applies (USD native and FX-free,
    EUR derived). Unlike the Day curve, the day-drifting NAV funds are *not* held
    flat: each session's points carry that day's published NAV (see
    :func:`intraday_snapshots_service.week_nav_drift_with_fx`), so a fund whose
    NAV moved across the week slopes instead of sitting flat. The live current
    value caps the curve so the tip matches the headline figure.

    Returns ``[]`` when no intraday history could be sourced (e.g. offline, or an
    empty ledger), letting the caller fall back to the daily snapshot series.

    ``freeze_after_hours`` freezes the EUR view's live tip to the session-close FX
    once the US market has shut, exactly as the Day curve does, so the week's
    market-day trajectory does not slide with overnight FX (see
    :mod:`investment_dashboard.domain.session_fx`).

    This is the **window(WEEK_SESSIONS)** case of the unified
    :func:`build_window_value_series`.
    """
    return build_window_value_series(
        session,
        currency=currency,
        sessions=intraday_snapshots_service.WEEK_SESSIONS,
        tz=tz,
        now=now,
        positions=positions,
        freeze_after_hours=freeze_after_hours,
    )


def previous_session_close_value(
    session: Session,
    *,
    currency: str,
    now: datetime | None = None,
) -> Decimal | None:
    """Settled portfolio value at the close of the session *before* the "Day" one.

    This is the reference the Overview "1 Day" chart marks so the user can see
    whether the live value is above or below where the portfolio last *closed* —
    a positive day that drifts down from the open can still leave the value above
    the prior close, which a bare intraday curve hides.

    Returns the value in ``currency`` (display) for the trading day immediately
    before the session shown by the "Day" range, or ``None`` when no settled
    value can be computed (e.g. a brand-new portfolio).
    """
    now = now or datetime.now(UTC)
    session_date = intraday_snapshots_service.last_session_date(now)
    prev_date = intraday_snapshots_service.previous_trading_session(session_date)
    try:
        value = snapshots_service.get_or_compute_in_currency(session, prev_date, currency)
    except Exception:  # pragma: no cover - defensive: keep the chart renderable
        return None
    return value if value != 0 else None


@dataclass(frozen=True)
class TreemapDatum:
    """One slice of the allocation treemap."""

    label: str
    value_eur: Decimal


@dataclass(frozen=True)
class InstrumentMetrics:
    """Per-instrument return figures mirroring the spreadsheet's ``Lots`` block.

    All ratios are fractions (``0.12`` = +12 %). The legacy ``xirr`` /
    ``total_growth_pct`` / ``ytd_growth_pct`` / ``capital_gain_native`` fields
    are retained for the JSON read-model / API. The v2.8.2 ``*_eur`` / ``*_usd``
    fields are the ones the Overview table renders: every money figure is the
    real per-currency value (cost basis converted at each buy's **trade-date**
    FX, current value at today's FX) rounded to the cent, and every return is
    computed independently per currency. ``None`` means "not computable" (no
    cost basis / no prior price) so the renderer shows an em dash.
    """

    instrument_id: int
    # Legacy native-currency figures (kept for readmodels / API back-compat).
    xirr: Decimal | None
    total_growth_pct: Decimal | None
    ytd_growth_pct: Decimal | None
    capital_gain_native: Decimal
    expense_ratio: Decimal | None
    # v2.8.2 per-currency figures (drive the Overview table).
    cost_basis_eur: Decimal = ZERO
    cost_basis_usd: Decimal = ZERO
    current_value_eur: Decimal = ZERO
    current_value_usd: Decimal | None = ZERO
    capital_gain_eur: Decimal = ZERO
    capital_gain_usd: Decimal | None = ZERO
    total_growth_eur: Decimal | None = None
    total_growth_usd: Decimal | None = None
    xirr_eur: Decimal | None = None
    xirr_usd: Decimal | None = None
    ytd_growth_eur: Decimal | None = None
    ytd_growth_usd: Decimal | None = None
    mtd_growth_eur: Decimal | None = None
    mtd_growth_usd: Decimal | None = None
    daily_growth_eur: Decimal | None = None
    daily_growth_usd: Decimal | None = None
    #: Signed single-day *money* move (change in value) per currency, used to
    #: rank today's biggest movers. ``None`` when no daily move is computable.
    daily_move_eur: Decimal | None = None
    daily_move_usd: Decimal | None = None
    #: The print date today's move lands on (the newest close diffed). Lets the
    #: overview tell which holdings have repriced more recently than their peers.
    daily_growth_as_of: date | None = None


def get_metrics(session: Session, *, as_of: date | None = None) -> PortfolioMetrics:
    return compute_portfolio_metrics(session, as_of=as_of)


def get_positions(session: Session, *, as_of: date | None = None) -> list[Position]:
    return compute_positions(session, as_of=as_of)


def _convert_native(
    value_native: Decimal,
    native_currency: str,
    on: date,
    eur_to_usd: dict[date, Decimal],
    fallback_rate: Decimal | None,
) -> tuple[Decimal, Decimal]:
    """Convert a positive native-currency value to ``(eur, usd)`` at trade-date FX.

    Thin wrapper over :func:`dual_currency_amounts` that coerces the missing
    legs to :data:`ZERO` so cost-basis accumulation never trips over a sparse
    FX history (the boot refresh backfills rates to the earliest trade date).
    """
    eur, usd = dual_currency_amounts(
        native_currency=native_currency,
        net_native=value_native,
        net_eur=None,
        on=on,
        eur_to_usd=eur_to_usd,
        fallback_rate=fallback_rate,
    )
    return (eur or ZERO), (usd or ZERO)


def compute_instrument_metrics(  # noqa: PLR0912, PLR0915
    session: Session,
    positions: list[Position],
    *,
    as_of: date | None = None,
) -> dict[int, InstrumentMetrics]:
    """Per-instrument returns in EUR **and** USD, keyed by instrument id.

    Every money figure is computed per currency: the cost basis (and cash
    dividends) are converted at each transaction's own trade-date FX rate,
    while the current value uses today's FX — so the capital gain is "what I
    could cash out today vs what it cost me back then". XIRR, total growth,
    YTD growth and single-day (daily) growth are each computed twice, once per
    wallet, mirroring the portfolio-level KPIs.
    """
    as_of = as_of or date.today()
    txns = list(transactions_repo.list_transactions(session, end=as_of))
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    today_rate = lookup_rate_with_forward_fill(eur_to_usd, as_of)

    year_start = date(as_of.year, 1, 1)
    month_start = date(as_of.year, as_of.month, 1)
    eur_flows, usd_flows = build_instrument_cashflows(session, as_of=as_of)
    cost_eur: dict[int, Decimal] = {}
    cost_usd: dict[int, Decimal] = {}
    # Running share count per instrument, needed to release a proportional
    # slice of the cost basis on partial sales (average-cost method).
    shares_held: dict[int, Decimal] = {}
    div_eur: dict[int, Decimal] = {}
    div_usd: dict[int, Decimal] = {}
    ytd_invested_eur: dict[int, Decimal] = {}
    ytd_invested_usd: dict[int, Decimal] = {}
    mtd_invested_eur: dict[int, Decimal] = {}
    mtd_invested_usd: dict[int, Decimal] = {}
    # Cash-dividend legs that were immediately reinvested must not be counted
    # as income (already captured as cost basis + shares via the reinvest
    # leg), otherwise growth double-counts them.
    reinvest_keys: set[tuple[int | None, date]] = {
        (t.instrument_id, t.date) for t in txns if t.kind == TransactionKind.DIVIDEND_REINVEST.value
    }
    # Money-market funds price at par ($1), so their reinvested dividends are the
    # actual return rather than a cost. Excluding those reinvest legs from the
    # cost basis (mirroring positions_service) lets their gain/growth reflect the
    # earned dividends instead of collapsing to zero.
    mm_iids: set[int] = {
        p.instrument.id
        for p in positions
        if is_money_market(
            p.instrument.symbol,
            asset_class=(
                p.effective.asset_class if p.effective is not None else p.instrument.asset_class
            ),
            name=(p.effective.name if p.effective is not None else p.instrument.name),
        )
    }
    for t in txns:
        iid = t.instrument_id
        if iid is None:
            continue
        native = t.account.native_currency if t.account else "EUR"
        eur, usd = dual_currency_amounts(
            native_currency=native,
            net_native=t.net_native,
            net_eur=t.net_eur,
            net_usd=t.net_usd,
            on=t.date,
            eur_to_usd=eur_to_usd,
            fallback_rate=today_rate,
        )
        eur = eur or ZERO
        usd = usd or ZERO
        qty = t.quantity or ZERO
        kind = t.kind
        if kind == TransactionKind.BUY.value:
            # Buy legs are negative (cash out) ⇒ cost basis is the negation.
            cost_eur[iid] = cost_eur.get(iid, ZERO) - eur
            cost_usd[iid] = cost_usd.get(iid, ZERO) - usd
            shares_held[iid] = shares_held.get(iid, ZERO) + qty
        elif kind == TransactionKind.SELL.value:
            # Average-cost partial-sale handling: release the sold shares'
            # proportional slice of the cost basis in each currency.
            shares_before = shares_held.get(iid, ZERO)
            if shares_before > ZERO:
                sold = min(-qty, shares_before)
                frac = sold / shares_before
                cost_eur[iid] = cost_eur.get(iid, ZERO) * (1 - frac)
                cost_usd[iid] = cost_usd.get(iid, ZERO) * (1 - frac)
            shares_held[iid] = shares_before + qty
        elif kind == TransactionKind.DIVIDEND_REINVEST.value and t.price_native is not None:
            shares_held[iid] = shares_held.get(iid, ZERO) + qty
            # Money-market reinvests are return, not cost (see ``mm_iids`` above).
            if iid not in mm_iids:
                val_native = qty * t.price_native
                e, u = _convert_native(val_native, native, t.date, eur_to_usd, today_rate)
                cost_eur[iid] = cost_eur.get(iid, ZERO) + e
                cost_usd[iid] = cost_usd.get(iid, ZERO) + u
        elif kind == TransactionKind.SPLIT.value:
            shares_held[iid] = shares_held.get(iid, ZERO) + qty
        elif kind == TransactionKind.DIVIDEND_CASH.value:
            if (iid, t.date) not in reinvest_keys:
                div_eur[iid] = div_eur.get(iid, ZERO) + eur
                div_usd[iid] = div_usd.get(iid, ZERO) + usd
        if t.date >= year_start and kind in {
            TransactionKind.BUY.value,
            TransactionKind.SELL.value,
        }:
            ytd_invested_eur[iid] = ytd_invested_eur.get(iid, ZERO) - eur
            ytd_invested_usd[iid] = ytd_invested_usd.get(iid, ZERO) - usd
        if t.date >= month_start and kind in {
            TransactionKind.BUY.value,
            TransactionKind.SELL.value,
        }:
            mtd_invested_eur[iid] = mtd_invested_eur.get(iid, ZERO) - eur
            mtd_invested_usd[iid] = mtd_invested_usd.get(iid, ZERO) - usd

    # Start-of-year value per instrument in EUR (best-effort, for YTD growth);
    # USD parallel uses the FX rate on the first of the year. Reuse the ledger
    # already loaded above (``txns`` spans through ``as_of`` ⊇ year-start) so the
    # year-start roll-up does not issue a second full ledger query.
    fx_year_start = lookup_rate_with_forward_fill(eur_to_usd, year_start) or today_rate
    start_value_eur: dict[int, Decimal] = {
        p.instrument.id: p.current_value_eur
        for p in compute_positions(session, as_of=year_start, transactions=txns)
    }
    # Start-of-month value per instrument (for MTD growth), same approach.
    fx_month_start = lookup_rate_with_forward_fill(eur_to_usd, month_start) or today_rate
    month_start_value_eur: dict[int, Decimal] = {
        p.instrument.id: p.current_value_eur
        for p in compute_positions(session, as_of=month_start, transactions=txns)
    }

    out: dict[int, InstrumentMetrics] = {}
    # Batch the daily-growth price lookups once for every held instrument
    # instead of issuing recent_price_dates + two close_as_of per position
    # (an N+1 over the holdings table).
    recent_closes = prices_service.recent_closes_by_instrument(
        session,
        [p.instrument.id for p in positions],
        on_or_before=as_of,
        limit=2,
    )
    book_price_dates = sorted(
        {price_date for pairs in recent_closes.values() for price_date, _ in pairs},
        reverse=True,
    )
    latest_price_date = book_price_dates[0] if book_price_dates else None
    previous_price_date = book_price_dates[1] if len(book_price_dates) > 1 else None
    for p in positions:
        iid = p.instrument.id
        native = p.account.native_currency
        c_eur = _round_cent(cost_eur.get(iid, ZERO))
        c_usd = _round_cent(cost_usd.get(iid, ZERO))
        cv_eur = p.current_value_eur
        # When the EUR→USD spot is unavailable we degrade the USD figures to
        # ``None`` (blank) rather than relabelling the EUR amount as USD —
        # otherwise XIRR(USD) / growth(USD) would be computed against a
        # terminal value that is euros pretending to be dollars.
        cv_usd = cv_eur * today_rate if today_rate not in (None, 0) else None
        d_eur = div_eur.get(iid, ZERO)
        d_usd = div_usd.get(iid, ZERO)
        gain_eur = _round_cent(cv_eur + d_eur - c_eur)
        gain_usd = _round_cent(cv_usd + d_usd - c_usd) if cv_usd is not None else None
        xirr_eur = xirr(eur_flows.get(iid, []), as_of=as_of, terminal_value=cv_eur)
        xirr_usd = (
            xirr(usd_flows.get(iid, []), as_of=as_of, terminal_value=cv_usd)
            if cv_usd is not None
            else None
        )
        # Total Growth mirrors the portfolio headline: the compounded
        # ``(1 + XIRR) ^ years − 1`` return over the time actually invested in
        # this holding, *not* a simple gain/cost ratio. The simple ratio badly
        # understates holdings the user is still buying into regularly (a large,
        # recently-added cost basis has had little time to grow), so it diverged
        # from the spreadsheet. ``years`` runs from the instrument's first
        # cashflow to ``as_of``. When the compounded figure is undefined (no XIRR
        # root, or a same-day position with ~0 years) we fall back to the simple
        # gain/cost so a brand-new holding still reads a sensible number.
        first_flow = min(
            (cf.date for cf in eur_flows.get(iid, [])),
            default=None,
        )
        held_years = years_between(first_flow, as_of) if first_flow is not None else ZERO
        simple_growth_eur = (gain_eur / c_eur) if c_eur != ZERO else None
        simple_growth_usd = (gain_usd / c_usd) if (gain_usd is not None and c_usd != ZERO) else None
        growth_eur = total_growth_pct_compounded(xirr_eur, held_years)
        if growth_eur is None:
            growth_eur = simple_growth_eur
        growth_usd = total_growth_pct_compounded(xirr_usd, held_years)
        if growth_usd is None:
            growth_usd = simple_growth_usd
        sv_eur = start_value_eur.get(iid, ZERO)
        sv_usd = sv_eur * fx_year_start if fx_year_start not in (None, 0) else None
        ytd_eur = _instrument_ytd_growth(
            start_value=sv_eur,
            current_value=cv_eur,
            net_invested=ytd_invested_eur.get(iid, ZERO),
        )
        ytd_usd = (
            _instrument_ytd_growth(
                start_value=sv_usd,
                current_value=cv_usd,
                net_invested=ytd_invested_usd.get(iid, ZERO),
            )
            if (sv_usd is not None and cv_usd is not None)
            else None
        )
        msv_eur = month_start_value_eur.get(iid, ZERO)
        msv_usd = msv_eur * fx_month_start if fx_month_start not in (None, 0) else None
        mtd_eur = _instrument_ytd_growth(
            start_value=msv_eur,
            current_value=cv_eur,
            net_invested=mtd_invested_eur.get(iid, ZERO),
        )
        mtd_usd = (
            _instrument_ytd_growth(
                start_value=msv_usd,
                current_value=cv_usd,
                net_invested=mtd_invested_usd.get(iid, ZERO),
            )
            if (msv_usd is not None and cv_usd is not None)
            else None
        )
        eff_name = p.effective.name if p.effective is not None else p.instrument.name
        eff_class = p.effective.asset_class if p.effective is not None else p.instrument.asset_class
        is_mm = is_money_market(p.instrument.symbol, asset_class=eff_class, name=eff_name)
        daily_eur, daily_usd, daily_move_eur, daily_move_usd, daily_as_of = (
            _instrument_daily_growth(
                instrument_id=iid,
                shares=p.shares,
                native_currency=native,
                eur_to_usd=eur_to_usd,
                today_rate=today_rate,
                recent_closes=recent_closes,
                latest_price_date=latest_price_date,
                previous_price_date=previous_price_date,
                is_money_market=is_mm,
            )
        )
        ter = p.effective.expense_ratio if p.effective is not None else p.instrument.expense_ratio
        # Legacy native-currency figures (readmodels / API back-compat).
        cost_native = p.cost_basis_native
        gain_native = p.current_value_native + p.cumulative_dividends_cash_native - cost_native
        out[iid] = InstrumentMetrics(
            instrument_id=iid,
            xirr=xirr_eur,
            total_growth_pct=((gain_native / cost_native) if cost_native != ZERO else None),
            ytd_growth_pct=ytd_eur,
            capital_gain_native=gain_native,
            expense_ratio=ter,
            cost_basis_eur=c_eur,
            cost_basis_usd=c_usd,
            current_value_eur=_round_cent(cv_eur),
            current_value_usd=_round_cent(cv_usd) if cv_usd is not None else None,
            capital_gain_eur=gain_eur,
            capital_gain_usd=gain_usd,
            total_growth_eur=growth_eur,
            total_growth_usd=growth_usd,
            xirr_eur=xirr_eur,
            xirr_usd=xirr_usd,
            ytd_growth_eur=ytd_eur,
            ytd_growth_usd=ytd_usd,
            mtd_growth_eur=mtd_eur,
            mtd_growth_usd=mtd_usd,
            daily_growth_eur=daily_eur,
            daily_growth_usd=daily_usd,
            daily_move_eur=daily_move_eur,
            daily_move_usd=daily_move_usd,
            daily_growth_as_of=daily_as_of,
        )
    return out


def _round_cent(value: Decimal) -> Decimal:
    """Round a money amount to the nearest cent (half-up)."""
    return value.quantize(_CENT, rounding=ROUND_HALF_UP)


def _instrument_daily_growth(  # noqa: PLR0911
    *,
    instrument_id: int,
    shares: Decimal,
    native_currency: str,
    eur_to_usd: dict[date, Decimal],
    today_rate: Decimal | None,
    recent_closes: dict[int, list[tuple[date, Decimal]]],
    latest_price_date: date | None = None,
    previous_price_date: date | None = None,
    is_money_market: bool = False,
) -> tuple[Decimal | None, Decimal | None, Decimal | None, Decimal | None, date | None]:
    """Single-day growth for one instrument, in EUR and USD.

    Values the holding on the book's two most recent print dates. Holdings that
    did not reprint on the freshest date are forward-filled, so they contribute
    zero price move and only the FX revaluation between the book dates.

    Returns a 5-tuple ``(growth_eur, growth_usd, move_eur, move_usd,
    last_date)``: the two growth *fractions*, the two signed *money* moves (the
    actual change in value, used to rank today's biggest movers), and the date
    the move lands on (the newest print date, used to tell which holdings have
    repriced more recently than their peers). ``last_date`` is ``None`` only
    when there is no move to date.

    ``recent_closes`` is the batched ``{instrument_id: [(date, close), …]}``
    map built once for every held instrument, so this helper does no DB I/O of
    its own (the previous per-instrument ``recent_price_dates`` + two
    ``close_as_of`` calls were an N+1 over the holdings table).

    Money-market / settlement funds hold a constant $1.00 NAV with no price
    feed, so they have no print dates to diff and genuinely do not move in
    price. Their single-day growth is therefore blank (an em dash) rather than
    a misleading ``0`` — a money-market fund has no daily move to report.
    """
    if is_money_market:
        return None, None, None, None, None
    pairs = recent_closes.get(instrument_id, [])
    if not pairs:
        return None, None, None, None, None
    last_date, close_last = pairs[0]
    if close_last is None:
        return None, None, None, None, None

    if (
        latest_price_date is not None
        and previous_price_date is not None
        and last_date < latest_price_date
    ):
        current_native = shares * close_last
        e_last, u_last = _convert_native(
            current_native, native_currency, latest_price_date, eur_to_usd, today_rate
        )
        e_prev, u_prev = _convert_native(
            current_native, native_currency, previous_price_date, eur_to_usd, today_rate
        )
        growth_eur = (e_last - e_prev) / e_prev if e_prev > ZERO else None
        growth_usd = (u_last - u_prev) / u_prev if u_prev > ZERO else None
        move_eur = _round_cent(e_last - e_prev)
        move_usd = _round_cent(u_last - u_prev)
        return growth_eur, growth_usd, move_eur, move_usd, last_date

    if len(pairs) < 2:
        return None, None, None, None, None
    prev_date, close_prev = pairs[1]
    if close_prev is None:
        return None, None, None, None, None
    current_book_date = latest_price_date or last_date
    previous_book_date = previous_price_date or prev_date
    e_last, u_last = _convert_native(
        shares * close_last, native_currency, current_book_date, eur_to_usd, today_rate
    )
    e_prev, u_prev = _convert_native(
        shares * close_prev, native_currency, previous_book_date, eur_to_usd, today_rate
    )
    growth_eur = (e_last - e_prev) / e_prev if e_prev > ZERO else None
    growth_usd = (u_last - u_prev) / u_prev if u_prev > ZERO else None
    move_eur = _round_cent(e_last - e_prev)
    move_usd = _round_cent(u_last - u_prev)
    return growth_eur, growth_usd, move_eur, move_usd, last_date


def _instrument_ytd_growth(
    *,
    start_value: Decimal,
    current_value: Decimal,
    net_invested: Decimal,
) -> Decimal | None:
    """Simple YTD growth net of this year's purchases, in native currency.

    ``(V_now - V_jan1 - net_invested_ytd) / V_jan1``. ``None`` when there
    was no start-of-year mark to grow from.
    """
    if start_value <= ZERO:
        return None
    return (current_value - start_value - net_invested) / start_value


@dataclass(frozen=True)
class MarketVerdict:
    """ "Did I beat the market?" comparison for the overview KPI strip.

    Mirrors the spreadsheet's ``Total!Z23`` verdict. Both sides are computed
    with the **same** method over the **same** horizon: an XIRR over the
    portfolio's external contribution cashflows, expressed as the compounded
    total growth ``(1 + XIRR) ^ years − 1`` it implies over the time invested.
    ``portfolio_return`` is the portfolio's own XIRR-implied growth; the
    ``benchmark_return`` is the growth those identical contributions would have
    earned in a buy-and-hold of the benchmark index. ``beating`` compares the
    two annualised XIRRs (equivalently, the two compounded returns over the same
    horizon) and is ``None`` when either side can't be computed (no benchmark
    history / no transactions).
    """

    benchmark_symbol: str
    portfolio_return: Decimal | None
    benchmark_return: Decimal | None
    beating: bool | None


def compute_market_verdict(
    session: Session,
    *,
    portfolio_xirr: Decimal | None,
    years: Decimal | None,
    as_of: date | None = None,
) -> MarketVerdict:
    """Compare the portfolio XIRR to the same contributions invested in the
    benchmark index, on an apples-to-apples XIRR basis.

    ``portfolio_xirr`` / ``years`` come from the portfolio metrics (EUR basis).
    The benchmark XIRR is simulated by routing the portfolio's external
    contribution cashflows into the index (see
    :func:`benchmark_service.simulate_benchmark_xirr`). Both XIRRs are converted
    to the compounded total-growth family the overview headlines so the verdict
    and the headline never quote two different "growth" numbers.
    """
    # Local import keeps the (heavier) benchmark/adapters import lazy and
    # avoids any chance of an import cycle at module load.
    from investment_dashboard.services import benchmark_service  # noqa: PLC0415

    as_of = as_of or date.today()
    symbol = benchmark_service.get_symbol(session)

    benchmark_xirr = benchmark_service.simulate_benchmark_xirr(session, as_of=as_of)

    portfolio_return: Decimal | None = None
    benchmark_return: Decimal | None = None
    if years is not None and years > ZERO:
        portfolio_return = total_growth_pct_compounded(portfolio_xirr, years)
        benchmark_return = total_growth_pct_compounded(benchmark_xirr, years)

    beating: bool | None = None
    if portfolio_xirr is not None and benchmark_xirr is not None:
        beating = portfolio_xirr >= benchmark_xirr
    return MarketVerdict(symbol, portfolio_return, benchmark_return, beating)


def _today_dual(
    value_native: Decimal, native: str, fx_rate: Decimal | None
) -> tuple[Decimal | None, Decimal | None]:
    """Convert a native amount to ``(eur, usd)`` using today's spot ``fx_rate``.

    Only used as a degraded fallback in :func:`position_rows` when no enriched
    per-instrument metrics are supplied; the live page always passes metrics
    (trade-date FX). ``fx_rate`` is EUR→USD.
    """
    if native == "EUR":
        eur = value_native
        usd = value_native * fx_rate if fx_rate not in (None, 0) else None
    elif native == "USD":
        usd = value_native
        eur = value_native / fx_rate if fx_rate not in (None, 0) else None
    else:  # pragma: no cover - defensive: unsupported native currency
        eur = usd = None
    return eur, usd


def position_rows(
    positions: list[Position],
    *,
    display_currency: str = "EUR",
    fx_rate: Decimal | None = None,
    metrics: dict[int, InstrumentMetrics] | None = None,
    price_anomaly_ids: set[int] | None = None,
    freshness: dict[int, HoldingFreshness] | None = None,
) -> list[dict[str, Any]]:
    """Shape positions for the AG-Grid table on the overview page.

    Every money / return value is carried per currency as a numeric companion
    (``*_eur_num`` / ``*_usd_num`` for money, ``*_eur_signed`` / ``*_usd_signed``
    for ratios) so the page can render **one currency at a time** (the display
    toggle) while still sorting by the underlying value. When ``metrics`` (from
    :func:`compute_instrument_metrics`) is supplied the figures are the real
    per-currency numbers — cost basis at trade-date FX, capital gain vs today's
    FX, plus per-currency XIRR, total growth, YTD growth and single-day growth.
    Without metrics it falls back to a today's-spot conversion of the native
    cost basis / value, with the return columns left blank.

    ``price_anomaly_ids`` are instrument ids whose cached price history holds a
    non-positive close (a corrupt feed value); their rows carry
    ``price_data_warning`` so the page can flag that the instrument's historical
    valuations are unreliable.
    """
    rows: list[dict[str, Any]] = []
    metrics = metrics or {}
    anomalies = price_anomaly_ids or set()
    fresh = freshness or {}
    for p in positions:
        native = p.account.native_currency
        im = metrics.get(p.instrument.id)
        if im is not None:
            cb_eur, cb_usd = im.cost_basis_eur, im.cost_basis_usd
            v_eur, v_usd = im.current_value_eur, im.current_value_usd
            g_eur, g_usd = im.capital_gain_eur, im.capital_gain_usd
            tg_eur, tg_usd = im.total_growth_eur, im.total_growth_usd
            xirr_eur, xirr_usd = im.xirr_eur, im.xirr_usd
            ytd_eur, ytd_usd = im.ytd_growth_eur, im.ytd_growth_usd
            mtd_eur, mtd_usd = im.mtd_growth_eur, im.mtd_growth_usd
            daily_eur, daily_usd = im.daily_growth_eur, im.daily_growth_usd
            ter = im.expense_ratio
        else:
            cb_eur, cb_usd = _today_dual(p.cost_basis_native, native, fx_rate)
            v_eur = p.current_value_eur
            v_usd = p.current_value_eur * fx_rate if fx_rate not in (None, 0) else None
            g_eur = (v_eur - cb_eur) if (v_eur is not None and cb_eur is not None) else None
            g_usd = (v_usd - cb_usd) if (v_usd is not None and cb_usd is not None) else None
            tg_eur = (g_eur / cb_eur) if (g_eur is not None and cb_eur) else None
            tg_usd = (g_usd / cb_usd) if (g_usd is not None and cb_usd) else None
            xirr_eur = xirr_usd = ytd_eur = ytd_usd = daily_eur = daily_usd = None
            mtd_eur = mtd_usd = None
            ter = None
        eff = p.effective
        fr = fresh.get(p.instrument.id)
        rows.append(
            {
                "symbol": p.instrument.symbol,
                "instrument_id": p.instrument.id,
                "value_warning": p.value_warning,
                "price_data_warning": p.instrument.id in anomalies,
                # Price freshness ("as of" the observation date) for the table's
                # transparency column. Money-market par funds have no feed date.
                "price_as_of": _fmt_asof(fr, now=datetime.now(UTC)),
                "name": (eff.name if eff is not None else p.instrument.name) or "",
                "category": p.category or "",
                "shares": fmt_shares(p.shares),
                "avg_price": (
                    f"{currency_symbol(native)}{(p.cost_basis_native / p.shares):,.2f}"
                    if p.shares
                    else ""
                ),
                "current_price": (
                    f"{currency_symbol(native)}{p.current_price_native:,.2f}"
                    if p.current_price_native is not None
                    else ""
                ),
                "expense_ratio": _fmt_pct(ter),
                # Per-currency numeric companions (one currency rendered at a
                # time via the display toggle; both kept so the toggle is
                # instant and each column sorts by its own value).
                "cost_basis_eur_num": _num(cb_eur),
                "cost_basis_usd_num": _num(cb_usd),
                "value_eur_num": _num(v_eur),
                "value_usd_num": _num(v_usd),
                "capital_gain_eur_num": _num(g_eur),
                "capital_gain_usd_num": _num(g_usd),
                "total_growth_eur_signed": _signed(tg_eur),
                "total_growth_usd_signed": _signed(tg_usd),
                "xirr_eur_signed": _signed(xirr_eur),
                "xirr_usd_signed": _signed(xirr_usd),
                "ytd_eur_signed": _signed(ytd_eur),
                "ytd_usd_signed": _signed(ytd_usd),
                "mtd_eur_signed": _signed(mtd_eur),
                "mtd_usd_signed": _signed(mtd_usd),
                "daily_eur_signed": _signed(daily_eur),
                "daily_usd_signed": _signed(daily_usd),
                # Portfolio weight (this holding's EUR value ÷ the total of all
                # held EUR values). Filled in a second pass once the grand total
                # is known. A fraction (``0.12`` = 12 %) so the grid's percent
                # formatter renders it. Weight is currency-independent (a ratio),
                # so a single column serves both display currencies.
                "weight_num": None,
                "display_currency": display_currency,
            }
        )
    # Second pass: portfolio weight needs the grand total of all EUR values.
    total_value_eur = sum(
        (Decimal(str(r["value_eur_num"])) for r in rows if r["value_eur_num"] is not None),
        ZERO,
    )
    if total_value_eur > ZERO:
        for r in rows:
            v = r["value_eur_num"]
            r["weight_num"] = (Decimal(str(v)) / total_value_eur) if v is not None else None
            if r["weight_num"] is not None:
                r["weight_num"] = float(r["weight_num"])
    return rows


def _fmt_pct(value: Decimal | None) -> str:
    if value is None:
        return "—"
    return f"{value * Decimal(100):,.2f} %"


def _fmt_asof(
    freshness: HoldingFreshness | None,
    *,
    today: date | None = None,
    now: datetime | None = None,
) -> str:
    """Compact freshness string for a holding's "As Of" cell.

    Today's price is promoted to a status word so the row reads at a glance,
    using the *same* "is it live?" rule as the header chip and the Daily Growth
    caption (``market open`` **and** ``a fresh price landed recently``):

    * ``LIVE``  — the price is from today, the US market is open right now, and a
      fresh pull landed within the live window, so it is a genuinely current,
      moving quote we can still access.
    * ``TODAY`` — the price is from today but the market is closed *or* the feed
      has gone stale/unreachable (a settled close that is current yet no longer
      moving). A stale feed never claims to be live.
    * ``as of <date>`` — anything older falls back to the observation date.

    ``now`` enables the recency gate; when omitted (``None``) the gate is skipped
    so a same-day, market-open price reads ``LIVE`` on the date check alone.

    Money-market funds price at a fixed par with no feed, so they keep "par".
    """
    if freshness is None:
        return "—"
    if freshness.is_money_market:
        return "par"
    if freshness.price_as_of is None:
        return "—"
    today = today or date.today()
    if freshness.price_as_of == today:
        if freshness.market_open and feed_is_fresh(freshness.updated_at, now):
            return "LIVE"
        return "TODAY"
    return freshness.price_as_of.strftime("%d %b %Y")


def _signed(value: Decimal | None) -> float:
    """Raw float for AG-Grid ``cellClassRules`` sign colouring (0 when None)."""
    return float(value) if value is not None else 0.0


def _num(value: Decimal | None) -> float | None:
    """Raw float for a sortable numeric AG-Grid column (``None`` stays empty)."""
    return float(value) if value is not None else None


def allocation_treemap(positions: list[Position]) -> list[TreemapDatum]:
    """Aggregate positions by user-tier ``category`` (fallback effective ``asset_class``)."""
    bucket: dict[str, Decimal] = {}
    for p in positions:
        eff = p.effective
        fallback_class = eff.asset_class if eff is not None else p.instrument.asset_class
        key = p.category or fallback_class or "Uncategorized"
        bucket[key] = bucket.get(key, ZERO) + p.current_value_eur
    items = [TreemapDatum(label=k, value_eur=v) for k, v in bucket.items() if v > ZERO]
    items.sort(key=lambda d: d.value_eur, reverse=True)
    return items


@dataclass(frozen=True)
class HoldingFreshness:
    """When a holding's displayed price was observed and last refreshed.

    Mirrors the web companion's per-row transparency for the desktop:

    * ``price_as_of`` — the *observation* date of the close the holding is
      valued at (the latest cached print). A stale-but-latest NAV then reads
      honestly ("as of 20 Jun") instead of pretending to be today's price.
    * ``updated_at`` — *when we last pulled* fresh prices for the instrument
      (the saved ``last_refreshed_at`` timestamp), so the user can tell a fresh
      fetch from a value that has simply not moved.
    * ``market_open`` — whether the instrument's exchange is open *right now*
      (best-effort, by quote currency). Lets a same-day price read "LIVE" while
      the market trades and "TODAY" once it has closed.

    Money-market / settlement funds price at a fixed $1.00 par with no feed, so
    both date fields are ``None`` and ``is_money_market`` is set — the UI shows a
    "fixed par" note rather than a misleading date.
    """

    price_as_of: date | None
    updated_at: datetime | None
    is_money_market: bool
    market_open: bool = False
    #: When the served price was last struck on the exchange (the provider's
    #: ``regularMarketTime``) — *when the price is from*, distinct from
    #: ``updated_at`` (*when we pulled it*). ``None`` when the provider does not
    #: publish it (or for money-market par rows).
    price_market_time: datetime | None = None


def holding_freshness(session: Session, positions: list[Position]) -> dict[int, HoldingFreshness]:
    """Per-instrument price freshness for the held ``positions`` (cache tier).

    Batches the cache-tier lookups (latest print date + last-refreshed timestamp
    + provider market time) once for every held instrument instead of per row.
    """
    ids = [p.instrument.id for p in positions]
    as_of_dates = prices_service.latest_price_dates_for(session, ids)
    refreshed = prices_service.last_refreshed_at_for(session, ids)
    market_times = prices_service.market_time_for(session, ids)
    out: dict[int, HoldingFreshness] = {}
    for p in positions:
        iid = p.instrument.id
        eff = p.effective
        eff_name = eff.name if eff is not None else p.instrument.name
        eff_class = eff.asset_class if eff is not None else p.instrument.asset_class
        is_mm = is_money_market(p.instrument.symbol, asset_class=eff_class, name=eff_name)
        out[iid] = HoldingFreshness(
            price_as_of=None if is_mm else as_of_dates.get(iid),
            updated_at=None if is_mm else refreshed.get(iid),
            is_money_market=is_mm,
            market_open=(False if is_mm else is_us_market_open()),
            price_market_time=None if is_mm else market_times.get(iid),
        )
    return out


@dataclass(frozen=True)
class HoldingCard:
    """View-model for one Overview holding card (the redesigned per-holding box).

    Carries raw per-currency :class:`~decimal.Decimal` figures (not formatted
    strings) so the renderer can format for the active display currency and
    colour by sign. ``weight`` is this holding's share of the portfolio's total
    EUR value; it is shown in the desktop Holdings table, not on the card.
    """

    instrument_id: int
    symbol: str
    name: str
    category: str
    native_currency: str
    is_money_market: bool
    value_warning: bool
    price_data_warning: bool
    shares: Decimal
    current_price_native: Decimal | None
    avg_price_native: Decimal | None
    expense_ratio: Decimal | None
    # Per-currency money + returns (EUR / USD).
    value_eur: Decimal | None
    value_usd: Decimal | None
    cost_basis_eur: Decimal
    cost_basis_usd: Decimal
    capital_gain_eur: Decimal | None
    capital_gain_usd: Decimal | None
    total_growth_eur: Decimal | None
    total_growth_usd: Decimal | None
    xirr_eur: Decimal | None
    xirr_usd: Decimal | None
    daily_growth_eur: Decimal | None
    daily_growth_usd: Decimal | None
    #: Signed single-day money move per currency (for the today's-movers board).
    daily_move_eur: Decimal | None
    daily_move_usd: Decimal | None
    ytd_growth_eur: Decimal | None
    ytd_growth_usd: Decimal | None
    weight: Decimal | None
    # Freshness / transparency.
    price_as_of: date | None
    updated_at: datetime | None
    market_open: bool = False
    #: The print date this holding's daily move lands on.
    daily_growth_as_of: date | None = None
    #: True when this holding's daily move is on an *older* print than the
    #: freshest peer (e.g. a fund still on yesterday's NAV) — so the figure is
    #: last session's move, not today's, and the overview greys it out. Resolved
    #: across the book in :func:`build_holding_cards`.
    daily_is_stale: bool = False


def build_holding_cards(
    positions: list[Position],
    *,
    metrics: dict[int, InstrumentMetrics] | None = None,
    freshness: dict[int, HoldingFreshness] | None = None,
    price_anomaly_ids: set[int] | None = None,
) -> list[HoldingCard]:
    """Shape held positions into Overview holding cards, sorted by EUR value.

    Each card mirrors the web companion's per-holding box (value, today's move,
    total growth, P/L, XIRR) and adds the desktop-native extras the user asked
    for — per-currency figures plus the price's "as of" date and saved update
    time. ``weight`` (share of portfolio) is computed here so the Holdings table
    can reuse the same figure.
    """
    metrics = metrics or {}
    freshness = freshness or {}
    anomalies = price_anomaly_ids or set()
    cards: list[HoldingCard] = []
    for p in positions:
        iid = p.instrument.id
        im = metrics.get(iid)
        fr = freshness.get(iid)
        eff = p.effective
        name = (eff.name if eff is not None else p.instrument.name) or p.instrument.symbol
        avg_price = (p.cost_basis_native / p.shares) if p.shares else None
        if im is not None:
            value_eur, value_usd = im.current_value_eur, im.current_value_usd
            cb_eur, cb_usd = im.cost_basis_eur, im.cost_basis_usd
            g_eur, g_usd = im.capital_gain_eur, im.capital_gain_usd
            tg_eur, tg_usd = im.total_growth_eur, im.total_growth_usd
            xirr_eur, xirr_usd = im.xirr_eur, im.xirr_usd
            daily_eur, daily_usd = im.daily_growth_eur, im.daily_growth_usd
            daily_move_eur, daily_move_usd = im.daily_move_eur, im.daily_move_usd
            daily_as_of = im.daily_growth_as_of
            ytd_eur, ytd_usd = im.ytd_growth_eur, im.ytd_growth_usd
            ter = im.expense_ratio
        else:
            value_eur = p.current_value_eur
            value_usd = None
            cb_eur = cb_usd = ZERO
            g_eur = g_usd = tg_eur = tg_usd = None
            xirr_eur = xirr_usd = daily_eur = daily_usd = ytd_eur = ytd_usd = None
            daily_move_eur = daily_move_usd = None
            daily_as_of = None
            ter = None
        cards.append(
            HoldingCard(
                instrument_id=iid,
                symbol=p.instrument.symbol,
                name=name,
                category=p.category or "",
                native_currency=p.account.native_currency,
                is_money_market=fr.is_money_market if fr is not None else False,
                value_warning=p.value_warning,
                price_data_warning=iid in anomalies,
                shares=p.shares,
                current_price_native=p.current_price_native,
                avg_price_native=avg_price,
                expense_ratio=ter,
                value_eur=value_eur,
                value_usd=value_usd,
                cost_basis_eur=cb_eur,
                cost_basis_usd=cb_usd,
                capital_gain_eur=g_eur,
                capital_gain_usd=g_usd,
                total_growth_eur=tg_eur,
                total_growth_usd=tg_usd,
                xirr_eur=xirr_eur,
                xirr_usd=xirr_usd,
                daily_growth_eur=daily_eur,
                daily_growth_usd=daily_usd,
                daily_move_eur=daily_move_eur,
                daily_move_usd=daily_move_usd,
                daily_growth_as_of=daily_as_of,
                ytd_growth_eur=ytd_eur,
                ytd_growth_usd=ytd_usd,
                weight=None,
                price_as_of=fr.price_as_of if fr is not None else None,
                updated_at=fr.updated_at if fr is not None else None,
                market_open=fr.market_open if fr is not None else False,
            )
        )
    # Portfolio weight: each card's EUR value as a share of the held total.
    total_value_eur = sum((c.value_eur for c in cards if c.value_eur is not None), ZERO)
    if total_value_eur > ZERO:

        def _with_weight(card: HoldingCard) -> HoldingCard:
            if card.value_eur is None:
                return card
            return replace(card, weight=card.value_eur / total_value_eur)

        cards = [_with_weight(c) for c in cards]
    # Flag holdings whose daily move sits on an older print than the freshest
    # peer: their today's figure is last session's move, so the overview greys
    # it. Before any holding reprices ahead of the rest, the freshest date is
    # shared and nothing is stale. Money-market funds carry no print date and so
    # are never flagged (their flat par move is honest as-is).
    freshest = max(
        (c.daily_growth_as_of for c in cards if c.daily_growth_as_of is not None),
        default=None,
    )
    if freshest is not None:
        cards = [
            replace(c, daily_is_stale=True)
            if c.daily_growth_as_of is not None and c.daily_growth_as_of < freshest
            else c
            for c in cards
        ]
    cards.sort(key=lambda c: c.value_eur if c.value_eur is not None else ZERO, reverse=True)
    return cards


@dataclass(frozen=True)
class MoverEntry:
    """One holding on the today's-movers (winners/losers) leaderboard.

    Carries the raw per-currency money move and percentage move so the renderer
    can format for the active display currency and colour by sign. ``reason``
    records why the holding earned its slot: ``"total"`` = biggest money move,
    ``"percent"`` = biggest percentage move.
    """

    symbol: str
    name: str
    move_eur: Decimal | None
    move_usd: Decimal | None
    pct_eur: Decimal | None
    pct_usd: Decimal | None
    reason: str


@dataclass(frozen=True)
class MoversView:
    """Today's biggest winners and losers, each capped at two entries.

    Each side shows the biggest money move and the biggest percentage move; when
    one holding tops both, the second slot becomes the percentage runner-up so
    two distinct names show. Only holdings that repriced on the freshest date are
    eligible — before the open that is every holding (so it reads last session's
    movers), and during the session only those that have already printed today.
    """

    winners: list[MoverEntry]
    losers: list[MoverEntry]
    #: The print date the movers are measured on, or ``None`` when nothing moved.
    basis_date: date | None
    #: How many holdings were eligible (a fresh, non-zero daily move).
    eligible_count: int


def _to_mover_entry(card: HoldingCard, reason: str) -> MoverEntry:
    return MoverEntry(
        symbol=card.symbol,
        name=card.name,
        move_eur=card.daily_move_eur,
        move_usd=card.daily_move_usd,
        pct_eur=card.daily_growth_eur,
        pct_usd=card.daily_growth_usd,
        reason=reason,
    )


def _move_for_currency(card: HoldingCard, currency: str) -> Decimal:
    """The money move to rank on, in ``currency`` (falls back to EUR)."""
    if currency.upper() == "USD" and card.daily_move_usd is not None:
        return card.daily_move_usd
    return card.daily_move_eur or ZERO


def _pct_for_currency(card: HoldingCard, currency: str) -> Decimal:
    """The percentage move to rank on, in ``currency`` (falls back to EUR).

    Unlike the money move, the daily percentage is genuinely FX-variant (EUR and
    USD percentages differ as the day's FX drifts), so the "top %" pick must be
    made in the display currency — the crux of the cross-currency discrepancy.
    """
    if currency.upper() == "USD" and card.daily_growth_usd is not None:
        return card.daily_growth_usd
    return card.daily_growth_eur or ZERO


def _pick_mover_side(
    pool: list[HoldingCard], *, descending: bool, currency: str
) -> list[MoverEntry]:
    """Pick up to two leaderboard entries from one side (winners or losers).

    The biggest money move comes first, then the biggest percentage move; when
    the same holding tops both, the second slot falls back to the percentage
    runner-up so two distinct names are shown. ``descending`` is ``True`` for
    winners (largest first) or ``False`` for losers (most negative first).
    Ranking is done in ``currency`` so the board matches the figures on screen
    (the "top %" pick in particular is FX-variant).
    """
    if not pool:
        return []
    by_money = sorted(pool, key=lambda c: _move_for_currency(c, currency), reverse=descending)
    by_pct = sorted(pool, key=lambda c: _pct_for_currency(c, currency), reverse=descending)
    top_total = by_money[0]
    entries = [_to_mover_entry(top_total, "total")]
    # The biggest-% holding, or — when it is also the biggest-money one — the
    # next holding by percentage, so a second, distinct name surfaces.
    top_pct = next(
        (c for c in by_pct if c.instrument_id != top_total.instrument_id),
        by_pct[0],
    )
    if top_pct.instrument_id != top_total.instrument_id:
        entries.append(_to_mover_entry(top_pct, "percent"))
    return entries


def build_movers(cards: list[HoldingCard], currency: str = "EUR") -> MoversView:
    """Build today's winners/losers leaderboard from the holding cards.

    Ranked in the active display ``currency``. Only holdings that repriced on the
    freshest date contribute (lagging funds are excluded), so before the open
    this reflects last session's movers and during the session only those already
    printed today. Ranking in the display currency (rather than always EUR) keeps
    the EUR and USD views — and the desktop and web apps — in agreement about who
    the biggest mover was. See :class:`MoversView`.
    """
    eligible = [
        c
        for c in cards
        if not c.daily_is_stale
        and c.daily_move_eur is not None
        and c.daily_growth_eur is not None
        and c.daily_move_eur != ZERO
    ]
    basis_date = max(
        (c.daily_growth_as_of for c in eligible if c.daily_growth_as_of is not None),
        default=None,
    )
    # Sign (winner vs loser) is FX-invariant, so the canonical EUR move decides
    # the side; the in-currency figures only reorder within a side.
    winners_pool = [c for c in eligible if (c.daily_move_eur or ZERO) > ZERO]
    losers_pool = [c for c in eligible if (c.daily_move_eur or ZERO) < ZERO]
    return MoversView(
        winners=_pick_mover_side(winners_pool, descending=True, currency=currency),
        losers=_pick_mover_side(losers_pool, descending=False, currency=currency),
        basis_date=basis_date,
        eligible_count=len(eligible),
    )
