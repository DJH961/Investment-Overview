"""Overview read-model — KPIs, per-instrument positions, and allocation.

Built entirely on top of the shared compute layer
(:mod:`investment_dashboard.services.metrics_service`,
:mod:`investment_dashboard.services.positions_service`) so the numbers
are identical to what the NiceGUI overview page renders.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, tzinfo
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import market_hours
from investment_dashboard.domain.currency_effect import compute_currency_effect
from investment_dashboard.domain.returns import years_between
from investment_dashboard.readmodels import fx_effect, holdings, live_graphs
from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec, iso
from investment_dashboard.readmodels.queries.overview_query import (
    HoldingCard,
    HoldingFreshness,
    InstrumentMetrics,
    MoverEntry,
    MoverEstimate,
    allocation_treemap,
    build_holding_cards,
    build_movers,
    compute_instrument_metrics,
    compute_market_verdict,
    holding_freshness,
)
from investment_dashboard.services import (
    fx_service,
    intraday_snapshots_service,
    investing_power_service,
    live_bus,
    metrics_service,
    prices_service,
    refresh_status,
    timezone_service,
)
from investment_dashboard.services.daily_growth_view import (
    build_daily_growth_caption,
    fx_move_pct,
)
from investment_dashboard.services.metrics_service import (
    PortfolioMetrics,
    compute_portfolio_metrics,
    with_last_session_daily_growth,
)
from investment_dashboard.services.positions_service import Position, compute_positions

ZERO = Decimal(0)


def _metrics_dict(metrics: PortfolioMetrics) -> dict[str, Any]:
    return {
        "as_of": metrics.as_of.isoformat(),
        "total_value_eur": dec(metrics.total_value_eur),
        "total_contributions_eur": dec(metrics.total_contributions_eur),
        "total_dividends_cash_eur": dec(metrics.total_dividends_cash_eur),
        "capital_gain_eur": dec(metrics.capital_gain_eur),
        "total_growth_pct": dec(metrics.total_growth_pct),
        "xirr": dec(metrics.xirr),
        "ytd_xirr": dec(metrics.ytd_xirr),
        "ytd_growth_pct": dec(metrics.ytd_growth_pct),
        "mtd_growth_pct": dec(metrics.mtd_growth_pct),
        "mtd_growth_pct_usd": dec(metrics.mtd_growth_pct_usd),
        "daily_growth_pct": dec(metrics.daily_growth_pct),
        "daily_growth_pct_usd": dec(metrics.daily_growth_pct_usd),
        "daily_growth_as_of": (
            metrics.daily_growth_as_of.isoformat() if metrics.daily_growth_as_of else None
        ),
        "weighted_expense_ratio": dec(metrics.weighted_expense_ratio),
        "annual_expense_cost_eur": dec(metrics.annual_expense_cost_eur),
        "dividend_yield_pct": dec(metrics.dividend_yield_pct),
    }


def _position_dict(
    p: Position,
    im: InstrumentMetrics | None = None,
    *,
    price_data_warning: bool = False,
) -> dict[str, Any]:
    eff = p.effective
    name = (eff.name if eff is not None else p.instrument.name) or ""
    asset_class = (eff.asset_class if eff is not None else p.instrument.asset_class) or ""
    avg_price = (p.cost_basis_native / p.shares) if p.shares else None
    fallback_growth: Decimal | None = None
    if p.cost_basis_native != ZERO:
        fallback_growth = (p.current_value_native - p.cost_basis_native) / p.cost_basis_native
    total_growth = im.total_growth_pct if im is not None else fallback_growth
    return {
        "broker": p.account.broker,
        "account": p.account.account_label,
        "native_currency": p.account.native_currency,
        "symbol": p.instrument.symbol,
        "name": name,
        "category": p.category or "",
        "asset_class": asset_class,
        "active": p.instrument_active,
        "shares": dec(p.shares),
        "avg_price_native": dec(avg_price),
        "current_price_native": dec(p.current_price_native),
        "expense_ratio": dec(im.expense_ratio if im is not None else None),
        "cost_basis_native": dec(p.cost_basis_native),
        "current_value_native": dec(p.current_value_native),
        "current_value_eur": dec(p.current_value_eur),
        "cumulative_dividends_cash_native": dec(p.cumulative_dividends_cash_native),
        "capital_gain_native": dec(im.capital_gain_native if im is not None else None),
        "total_growth_pct": dec(total_growth),
        "xirr": dec(im.xirr if im is not None else None),
        "ytd_growth_pct": dec(im.ytd_growth_pct if im is not None else None),
        # True when this instrument's cached history holds a non-positive close
        # (a corrupt feed value) that understates its historical valuations.
        "value_warning": p.value_warning,
        "price_data_warning": price_data_warning,
    }


def build(session: Session, *, context: ReadModelContext | None = None) -> dict[str, Any]:
    """Return the JSON-serializable overview read-model."""
    ctx = context or build_context(session)
    metrics = compute_portfolio_metrics(session, as_of=ctx.as_of)
    positions = compute_positions(session, as_of=ctx.as_of)
    instrument_metrics = compute_instrument_metrics(session, positions, as_of=ctx.as_of)
    price_anomaly_ids = prices_service.instruments_with_price_anomalies(
        session, [p.instrument.id for p in positions]
    )
    allocation = allocation_treemap(positions, fx_eur_usd=ctx.fx_rate_eur_usd)
    return {
        "metrics": _metrics_dict(metrics),
        "positions": [
            _position_dict(
                p,
                instrument_metrics.get(p.instrument.id),
                price_data_warning=p.instrument.id in price_anomaly_ids,
            )
            for p in positions
        ],
        "allocation": [
            {"label": d.label, "value_eur": dec(d.value_eur), "value_usd": dec(d.value_usd)}
            for d in allocation
        ],
    }


# -- v6 API ------------------------------------------------------------------


def _mover(entry: MoverEntry, ccy: str) -> dict[str, Any]:
    return {
        "symbol": entry.symbol,
        "name": entry.name,
        "move": dec(holdings.pick(entry.move_eur, entry.move_usd, ccy)),
        "pct": dec(holdings.pick(entry.pct_eur, entry.pct_usd, ccy)),
        "reason": entry.reason,
        "twin": entry.twin,
    }


def _mover_estimates(
    session: Session,
    estimates: dict[int, intraday_snapshots_service.TwinEstimate],
    *,
    now: datetime,
    fx_now: Decimal | None,
) -> dict[int, MoverEstimate]:
    """Each pending fund's estimated day move, in both currencies, for the movers board.

    💱 Both legs come from
    :func:`~investment_dashboard.services.intraday_snapshots_service.estimate_day_move`,
    which values today at the rate now and the previous close at that close's own rate.
    Each currency is built from its own legs — never one currency's move converted into
    the other — so the board's "top %" stays honest in whichever currency is on screen.

    ``fx_now`` is the context's one rate, the same one the holdings rows and the hero's
    estimated total use, so the board cannot disagree with the row it came from.
    """
    if not estimates:
        return {}
    session_date = intraday_snapshots_service.last_session_date(now)
    fx_prev = intraday_snapshots_service.previous_close_fx(session, session_date)
    out: dict[int, MoverEstimate] = {}
    for iid, est in estimates.items():
        move_eur, pct_eur = intraday_snapshots_service.estimate_day_move(
            est, fx_now, fx_prev, "EUR"
        )
        move_usd, pct_usd = intraday_snapshots_service.estimate_day_move(
            est, fx_now, fx_prev, "USD"
        )
        out[iid] = MoverEstimate(
            twin_symbol=est.twin_symbol,
            move_eur=move_eur,
            move_usd=move_usd,
            pct_eur=pct_eur,
            pct_usd=pct_usd,
            as_of=est.session_date,
        )
    return out


def _local_date(now: datetime, tz: tzinfo | None) -> date:
    return (now.astimezone(tz) if tz is not None else now).date()


def _fraction(pct: Decimal | None) -> Decimal | None:
    """``fx_move_pct`` returns percent; the API speaks fractions."""
    return None if pct is None else pct / Decimal(100)


def _since_phrase_kind(regime: fx_effect.FxBoxRegime, *, days_since_session: int) -> str:
    """``ui/pages/overview._effect_since_phrase`` as a kind (the client words it)."""
    if regime.forex_frozen:
        return "yesterday" if days_since_session <= 1 else "on_day"
    if regime.weekend_overnight:
        return "since_day"
    return "since_yesterday"


def _today_fx_view(
    session: Session,
    metrics: PortfolioMetrics,
    *,
    ccy: str,
    regime: fx_effect.FxBoxRegime,
    now: datetime,
    tz: tzinfo | None,
) -> dict[str, Any]:
    """The currency box's rate stats, exactly as ``ui/pages/overview._currency_box_html``.

    Regime-aware anchors: live -> previous close; US-only holiday -> previous close
    as one overnight drift; any other closed view -> the session open. Moves follow
    :func:`fx_move_pct`'s display-currency strength sign, as fractions.
    """
    live_fx = metrics.daily_growth_fx_eur_usd
    session_date = intraday_snapshots_service.last_session_date(now)
    local_today = _local_date(now, tz)
    phrase_kind = _since_phrase_kind(regime, days_since_session=(local_today - session_date).days)
    out: dict[str, Any] = {
        "pair": None,
        "spot_display": None,
        "move": None,
        "since": None,
        "as_of": None,
        "since_phrase": {"kind": phrase_kind, "session_date": session_date.isoformat()},
        "anchor_missing": False,
    }
    info = fx_service.eur_quote_as_of(
        session, quote="USD", today=market_hours.exchange_today(now), now=now
    )
    if info is not None:
        out["as_of"] = {
            "as_of": info.as_of.isoformat(),
            "source": info.source,
            "observed_at": info.observed_at.isoformat() if info.observed_at else None,
        }
    if live_fx is None or live_fx <= 0:
        return out
    prev_fx = metrics.daily_growth_fx_eur_usd_prev
    in_usd = ccy == "USD"
    out["pair"] = "EUR/USD" if in_usd else "USD/EUR"
    out["spot_display"] = dec(live_fx if in_usd else Decimal(1) / live_fx)

    if regime.market_open:
        anchor, anchor_kind = prev_fx, "prev_close"
    elif regime.single_overnight:
        anchor, anchor_kind = prev_fx, "overnight"
    else:
        anchor = intraday_snapshots_service.session_open_fx(session, now=now)
        anchor_kind = "session_open"
    if regime.forex_frozen:
        label_kind = "yesterday" if (local_today - session_date).days <= 1 else "weekday"
    else:
        label_kind = "today"
    out["move"] = {
        "pct": dec(_fraction(fx_move_pct(live_fx, anchor, ccy) if anchor is not None else None)),
        "anchor_kind": anchor_kind,
        "label_kind": label_kind,
        "session_date": session_date.isoformat(),
    }
    missing = anchor is None or anchor <= 0
    if regime.session_view:
        if regime.market_open:
            since_anchor = intraday_snapshots_service.session_open_fx(session, now=now)
            since_kind = "open"
        else:
            since_anchor = intraday_snapshots_service.session_close_fx(session, now=now)
            since_kind = "close"
        out["since"] = {
            "pct": dec(
                _fraction(
                    fx_move_pct(live_fx, since_anchor, ccy) if since_anchor is not None else None
                )
            ),
            "kind": since_kind,
        }
        missing = missing or since_anchor is None or since_anchor <= 0
    out["anchor_missing"] = missing
    return out


def _currency_effect_for(metrics: PortfolioMetrics, ccy: str, lifetime: Any) -> Decimal | None:
    """The lifetime currency effect against ``ccy``: its growth minus the USD growth.

    💱 A difference between two independently computed returns, in fractional
    points — never a return converted from one currency into another. For EUR this
    is exactly ``lifetime.currency_effect_pp`` (``growth_eur - growth_usd``); it is
    taken from there so the two can never drift apart. For USD it is 0: the
    investment return IS the dollar return, so the rate contributed nothing.
    """
    if ccy != "USD":
        return lifetime.currency_effect_pp
    return ZERO if metrics.total_growth_compounded_usd is not None else None


def _currency_block(
    session: Session,
    metrics: PortfolioMetrics,
    *,
    now: datetime,
    ccy: str = "EUR",
    tz: tzinfo | None = None,
) -> dict[str, Any]:
    """Lifetime split plus the "today" currency box (EUR effect or investing power)."""
    lifetime = compute_currency_effect(
        contributions_eur=metrics.total_contributions_eur,
        contributions_usd=metrics.total_contributions_usd,
        value_eur=metrics.total_value_eur,
        value_usd=metrics.total_value_usd,
        growth_eur=metrics.total_growth_compounded_eur,
        growth_usd=metrics.total_growth_compounded_usd,
    )
    live_fx = metrics.daily_growth_fx_eur_usd
    prev_fx = metrics.daily_growth_fx_eur_usd_prev
    spot = fx_service.active_live_spot("USD", now=now)
    regime = fx_effect.fx_box_regime(now)
    rate_move: Decimal | None = None
    if live_fx is not None and prev_fx is not None and prev_fx > 0:
        rate_move = (live_fx - prev_fx) / prev_fx  # fraction (0.0037 = 0.37 %)
    today: dict[str, Any] = {
        "spot": dec(live_fx),
        "prev": dec(prev_fx),
        "rate_move_pct": dec(rate_move),
        "spot_observed_at": (
            spot.observed_at.isoformat() if spot is not None and spot.observed_at else None
        ),
        "regime": {
            "market_open": regime.market_open,
            "forex_open": regime.forex_open,
            "holiday": regime.holiday,
            "forex_frozen": regime.forex_frozen,
            "weekend_overnight": regime.weekend_overnight,
            "single_overnight": regime.single_overnight,
            "session_view": regime.session_view,
        },
        "reopen_at": (
            market_hours.forex_market_reopen(now).isoformat() if regime.forex_frozen else None
        ),
        "effect_eur": None,
        "investing_power_usd": None,
    }
    today.update(_today_fx_view(session, metrics, ccy=ccy, regime=regime, now=now, tz=tz))
    if today["spot_observed_at"] is None and isinstance(today.get("as_of"), dict):
        today["spot_observed_at"] = today["as_of"].get("observed_at")
    if live_fx is not None and live_fx > 0 and metrics.total_value_usd is not None:
        eur_effect = fx_effect.compute_eur_fx_effect(
            session, metrics, live_fx=live_fx, prev_fx=prev_fx, now=now
        )
        if eur_effect is not None:
            today["effect_eur"] = {
                "net": dec(eur_effect.net_eur),
                "market_hours": dec(eur_effect.market_hours_eur),
                "overnight": dec(eur_effect.overnight_eur),
            }
        amount_eur = investing_power_service.get_amount_eur(session)
        if amount_eur > 0:
            power = fx_effect.compute_investing_power(
                session, metrics, amount_eur=amount_eur, live_fx=live_fx, now=now
            )
            if power is not None:
                today["investing_power_usd"] = {
                    "amount_eur": dec(amount_eur),
                    "amount_usd": dec(amount_eur * live_fx),
                    "net": dec(power.net_usd),
                    "market_hours": dec(power.market_hours_usd),
                    "overnight": dec(power.overnight_usd),
                }
    return {
        "lifetime": {
            "avg_invest_rate": dec(lifetime.avg_invest_rate),
            "current_rate": dec(lifetime.current_rate),
            "rate_change_pct": dec(lifetime.rate_change_pct),
            "fx_pnl_eur": dec(lifetime.fx_pnl_eur),
            "repatriation_value_eur": dec(lifetime.repatriation_value_eur),
            "breakeven_rate": dec(lifetime.breakeven_rate),
        },
        # Investment return (asset performance in the USD wallet) vs the currency
        # effect. Both returns are computed independently per currency; nothing is
        # converted — the effect is the *difference* between two returns, in points.
        #
        # 💱 The effect is taken against the REPORTING currency, not always EUR, so
        # the split reads the same way in either view: reporting growth ==
        # investment_return + currency_effect_pp. In a USD view of a USD book the
        # effect is 0 by construction (the rate did nothing to a dollar return),
        # which is the honest answer rather than a reason to hide the split.
        "return_split": {
            "total_return_eur": dec(metrics.total_growth_compounded_eur),
            "investment_return": dec(metrics.total_growth_compounded_usd),
            "currency_effect_pp": dec(_currency_effect_for(metrics, ccy, lifetime)),
        },
        "today": today,
    }


def _kpis(metrics: PortfolioMetrics, ccy: str, *, fx_rate: Decimal | None) -> dict[str, Any]:
    """The KPI block in ``ccy`` - every figure from that currency's own legs."""
    pick = holdings.pick
    # Single-instant conversion of the annual fee estimate at the spot rate.
    expense_cost: Decimal | None = metrics.annual_expense_cost_eur
    if ccy == "USD":
        rate = fx_rate
        expense_cost = expense_cost * rate if rate is not None else None

    # Total return = value + realised cash dividends - net contributions; capital
    # gain = total return - all dividend income (see ``portfolio_return_split``).
    total_return, capital_gain, _income = holdings.portfolio_return_split(metrics, ccy)

    return {
        "total_value": dec(pick(metrics.total_value_eur, metrics.total_value_usd, ccy)),
        "total_invested": dec(
            pick(metrics.total_contributions_eur, metrics.total_contributions_usd, ccy)
        ),
        "capital_gain": dec(capital_gain),
        "total_return": dec(total_return),
        "dividend_income": dec(
            pick(metrics.total_dividends_cash_eur, metrics.total_dividends_cash_usd, ccy)
        ),
        "dividends_ttm": dec(pick(metrics.dividends_ttm_eur, metrics.dividends_ttm_usd, ccy)),
        "xirr": dec(pick(metrics.xirr, metrics.xirr_usd, ccy)),
        "total_growth_compounded": dec(
            pick(metrics.total_growth_compounded_eur, metrics.total_growth_compounded_usd, ccy)
        ),
        "ytd_growth": dec(pick(metrics.ytd_growth_pct, metrics.ytd_growth_pct_usd, ccy)),
        "ytd_xirr": dec(pick(metrics.ytd_xirr, metrics.ytd_xirr_usd, ccy)),
        "mtd_growth": dec(pick(metrics.mtd_growth_pct, metrics.mtd_growth_pct_usd, ccy)),
        "daily_growth_pct": dec(pick(metrics.daily_growth_pct, metrics.daily_growth_pct_usd, ccy)),
        "daily_move": dec(
            pick(metrics.daily_growth_money_eur, metrics.daily_growth_money_usd, ccy)
        ),
        "daily_growth_as_of": iso(metrics.daily_growth_as_of),
        "weighted_expense_ratio": dec(metrics.weighted_expense_ratio),
        "annual_expense_cost": dec(expense_cost),
        "dividend_yield_pct": dec(metrics.dividend_yield_pct),
        "dividend_yield_ttm_pct": dec(metrics.dividend_yield_ttm_pct),
    }


def _estimate(
    metrics: PortfolioMetrics,
    ccy: str,
    *,
    estimates: dict[int, intraday_snapshots_service.TwinEstimate],
    fx_rate: Decimal | None,
    split: metrics_service.LastSessionSplit | None,
) -> dict[str, Any] | None:
    """``kpis.estimate``: the book with pending mutual funds at their ETF-twin estimate.

    Official total + ``sum(shares x (est_price - previous NAV))`` valued at the one
    rate now (a single instant), in ``ccy``'s own legs; ``None`` when no fund is
    estimating. The day move is the official one plus the same adjustment while the
    market runs; while it is shut it is the total change since the previous close, the
    last session's estimated move plus the overnight currency move
    (``split.move_est + split.overnight_est``).
    """
    if not estimates:
        return None
    adjustment = intraday_snapshots_service.estimate_adjustment(estimates.values(), fx_rate)
    total = holdings.pick(metrics.total_value_eur, metrics.total_value_usd, ccy)
    if total is None:
        return None
    delta = holdings.pick(adjustment[0], adjustment[1], ccy)
    if delta is None:
        return None
    move = holdings.pick(metrics.daily_growth_money_eur, metrics.daily_growth_money_usd, ccy)
    est_move: Decimal | None = None
    est_pct: Decimal | None = None
    if split is not None and split.move_est_eur is not None:
        usd = ccy == "USD"
        # Shut market: the TOTAL change of the estimated book since the previous close,
        # last session's estimated move plus the overnight currency move, i.e.
        # ``value_now_est - previous-close value`` (the split lines stay in ``last_session``).
        est_move = (split.move_est_usd if usd else split.move_est_eur) or ZERO
        est_move += (split.overnight_est_usd if usd else split.overnight_est_eur) or ZERO
        value_now_est = split.value_now_est_usd if usd else split.value_now_est_eur
        prev_value = value_now_est - est_move if value_now_est is not None else None
        est_pct = est_move / prev_value if prev_value is not None and prev_value > ZERO else None
    elif move is not None:
        est_move = move + delta
        est_pct = holdings.move_pct(total + delta, est_move)
    return {
        "total_value": dec(total + delta),
        "daily_move": dec(est_move),
        "daily_growth_pct": dec(est_pct),
        "funds": [
            {"symbol": e.symbol, "twin": e.twin_symbol}
            for e in sorted(estimates.values(), key=lambda e: e.symbol)
        ],
        "adjustment": dec(delta),
    }


def _max_time(times: Any) -> datetime | None:
    present = [t for t in times if t is not None]
    return max(present) if present else None


def _iso_utc(at: datetime | None) -> str | None:
    if at is None:
        return None
    return (at if at.tzinfo is not None else at.replace(tzinfo=UTC)).isoformat()


def _freshness(freshness: dict[int, HoldingFreshness], *, now: datetime) -> dict[str, Any]:
    """Live / Updated / Updating... state: market clock + refresh activity + price times."""
    from investment_dashboard.services import feed_stall_service  # noqa: PLC0415

    snap = refresh_status.snapshot()
    market_open = market_hours.is_us_market_open(now)
    stalled_since = feed_stall_service.stalled_since()
    return {
        "market_state": live_bus.market_state(now),
        "prices_live": market_hours.is_live_now(
            market_open=market_open,
            last_update_at=snap.last_price_update_at,
            now=now,
            price_market_at=feed_stall_service.newest_market_time(),
            feed_stalled=stalled_since is not None,
            window_seconds=feed_stall_service.live_max_age_seconds(),
            quote_max_age_seconds=feed_stall_service.live_max_age_seconds(),
        ),
        "feed_stalled_since": _iso_utc(stalled_since),
        "last_price_update_at": _iso_utc(snap.last_update_at),
        "price_market_at": _iso_utc(_max_time(f.price_market_time for f in freshness.values())),
        "price_observed_at": _iso_utc(_max_time(f.updated_at for f in freshness.values())),
        "refresh_running": snap.active,
        "refresh_source": snap.source,
        "historical": snap.historical,
        "progress_done": snap.progress_done,
        "progress_total": snap.progress_total,
        "progress_label": snap.progress_label,
    }


def _total_value_complete(cards: list[HoldingCard], *, fx_rate: Decimal | None) -> bool:
    """Every held position priced (and sanely), and EUR/USD known."""
    if fx_rate is None:
        return False
    for c in cards:
        if c.value_warning:
            return False
        if not c.is_money_market and c.shares > 0 and c.current_price_native is None:
            return False
    return True


def build_overview(
    session: Session,
    *,
    ccy: str,
    as_of: date | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The ``GET /api/overview`` payload for reporting currency ``ccy``."""
    now = now or datetime.now(UTC)
    ctx = build_context(session, as_of=as_of)
    metrics = compute_portfolio_metrics(session, as_of=ctx.as_of, now=now)
    # Before the open the latest trading day has no prices yet: show the last
    # session's move (as the v5 web app did) instead of a flat 0 %.
    metrics = with_last_session_daily_growth(
        session, metrics, session_date=intraday_snapshots_service.last_session_date(now), now=now
    )
    # Market shut: the hero move is the last session's official closes/NAVs (each
    # book at its own session's closing rate); the overnight currency is separate.
    split = metrics_service.last_session_split(session, now=now, fx_now=ctx.fx_rate_eur_usd)
    if split is not None:
        metrics = metrics_service.with_last_session_split(metrics, split)
    day_split = metrics_service.day_move_split(
        session, metrics, split=split, now=now, fx_now=ctx.fx_rate_eur_usd
    )
    usd = ccy == "USD"
    pick = holdings.pick

    positions = holdings.merge_positions_by_instrument(compute_positions(session, as_of=ctx.as_of))
    instrument_metrics = compute_instrument_metrics(session, positions, as_of=ctx.as_of)
    anomalies = prices_service.instruments_with_price_anomalies(
        session, [p.instrument.id for p in positions]
    )
    freshness = holding_freshness(session, positions)
    cards = build_holding_cards(
        positions,
        metrics=instrument_metrics,
        freshness=freshness,
        price_anomaly_ids=anomalies,
    )
    # Pending mutual funds valued from their ETF twin (same memoised plan as the
    # holdings, the tick and the 1D line): the hero's estimated total, and the
    # estimated day move that lets a late fund compete on the movers board.
    estimates = intraday_snapshots_service.twin_estimates(session, now)
    movers = build_movers(
        cards, ccy, _mover_estimates(session, estimates, now=now, fx_now=ctx.fx_rate_eur_usd)
    )

    # Both sides of the verdict are computed in the reporting currency (the
    # benchmark simulation supports EUR and USD), never converted across.
    verdict = compute_market_verdict(
        session,
        portfolio_xirr=pick(metrics.xirr, metrics.xirr_usd, ccy),
        currency=ccy,
        years=(
            years_between(metrics.first_cashflow_date, metrics.as_of)
            if metrics.first_cashflow_date
            else None
        ),
        as_of=metrics.as_of,
    )
    other = "EUR" if usd else "USD"
    estimate = _estimate(
        metrics, ccy, estimates=estimates, fx_rate=ctx.fx_rate_eur_usd, split=split
    )
    tz = timezone_service.resolve_tzinfo(timezone_service.get_timezone(session))
    fresh_view = _freshness(freshness, now=now)
    caption = build_daily_growth_caption(
        last_date=metrics.daily_growth_as_of,
        fx_eur_usd=metrics.daily_growth_fx_eur_usd,
        fx_eur_usd_prev=metrics.daily_growth_fx_eur_usd_prev,
        display_ccy=ccy,
        today=_local_date(now, tz),
        tz=tz,
        market_open=market_hours.is_us_market_open(now),
        price_observed_at=_max_time(f.updated_at for f in freshness.values()),
        price_market_at=_max_time(f.price_market_time for f in freshness.values()),
        now=now,
    )
    return {
        "ccy": ccy,
        "as_of": ctx.as_of.isoformat(),
        "generated_at": now.isoformat(),
        "fx_eur_usd": dec(ctx.fx_rate_eur_usd),
        "is_live": market_hours.is_us_market_open(now),
        "position_count": len(cards),
        "kpis": {**_kpis(metrics, ccy, fx_rate=ctx.fx_rate_eur_usd), "estimate": estimate},
        "secondary_ccy": other,
        "kpis_secondary": {
            **_kpis(metrics, other, fx_rate=ctx.fx_rate_eur_usd),
            "estimate": _estimate(
                metrics,
                other,
                estimates=estimates,
                fx_rate=ctx.fx_rate_eur_usd,
                split=split,
            ),
        },
        "freshness": fresh_view,
        "daily_caption": {
            "title": caption.title,
            "corner_text": caption.corner_text,
            "live": caption.is_live,
            "as_of_text": caption.as_of_text,
            "updated_text": caption.updated_text,
        },
        "default_range": live_graphs.default_range(session, now=now),
        "total_value_complete": _total_value_complete(cards, fx_rate=ctx.fx_rate_eur_usd),
        "currency": _currency_block(session, metrics, now=now, ccy=ccy, tz=tz),
        "market_verdict": {
            "benchmark_symbol": verdict.benchmark_symbol,
            "portfolio_return": dec(verdict.portfolio_return),
            "benchmark_return": dec(verdict.benchmark_return),
            "beating": verdict.beating,
        },
        "movers": {
            "basis_date": iso(movers.basis_date),
            "eligible_count": movers.eligible_count,
            "winners": [_mover(m, ccy) for m in movers.winners],
            "losers": [_mover(m, ccy) for m in movers.losers],
        },
        "warnings": {
            "zero_value": [c.symbol for c in cards if c.value_warning],
            "bad_history": [c.symbol for c in cards if c.price_data_warning],
            "missing_fx": ["EUR/USD"] if ctx.fx_rate_eur_usd is None else [],
        },
        "last_session": _last_session(split, ccy),
        "day_split": _day_split(day_split, ccy),
    }


def _day_split(split: metrics_service.DayMoveSplit | None, ccy: str) -> dict[str, Any] | None:
    """``day_split``: the headline day move as price + currency, in ``ccy`` and the other one."""
    if split is None:
        return None
    usd = ccy == "USD"
    return {
        "price_move": dec(split.price_usd if usd else split.price_eur),
        "currency_move": dec(split.currency_usd if usd else split.currency_eur),
        "price_move_secondary": dec(split.price_eur if usd else split.price_usd),
        "currency_move_secondary": dec(split.currency_eur if usd else split.currency_usd),
        "overnight": split.overnight,
        "estimated": split.estimated,
    }


def _last_session(
    split: metrics_service.LastSessionSplit | None, ccy: str
) -> dict[str, Any] | None:
    if split is None:
        return None
    usd = ccy == "USD"
    move = split.move_usd if usd else split.move_eur
    overnight = split.overnight_usd if usd else split.overnight_eur
    value_now = split.value_now_usd if usd else split.value_now_eur
    day_move = move + overnight
    prev_value = value_now - day_move
    return {
        "day_move": dec(day_move),
        "day_move_pct": dec(day_move / prev_value if prev_value > ZERO else None),
        "session_date": split.session_date.isoformat(),
        "prev_date": split.prev_date.isoformat(),
        "move": dec(split.move_usd if usd else split.move_eur),
        "move_pct": dec(split.pct_usd if usd else split.pct_eur),
        "overnight_currency": dec(split.overnight_usd if usd else split.overnight_eur),
        "value_now": dec(split.value_now_usd if usd else split.value_now_eur),
        "fx_close": dec(split.fx_close),
        "fx_now": dec(split.fx_now),
        "move_est": dec(split.move_est_usd if usd else split.move_est_eur),
        "move_pct_est": dec(split.pct_est_usd if usd else split.pct_est_eur),
        "overnight_currency_est": dec(split.overnight_est_usd if usd else split.overnight_est_eur),
        "value_now_est": dec(split.value_now_est_usd if usd else split.value_now_est_eur),
        "estimated_funds": list(split.estimated_funds),
    }
