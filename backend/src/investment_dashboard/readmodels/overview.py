"""Overview read-model — KPIs, per-instrument positions, and allocation.

Built entirely on top of the shared compute layer
(:mod:`investment_dashboard.services.metrics_service`,
:mod:`investment_dashboard.services.positions_service`) so the numbers
are identical to what the NiceGUI overview page renders.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import market_hours
from investment_dashboard.domain.currency_effect import compute_currency_effect
from investment_dashboard.domain.returns import years_between
from investment_dashboard.readmodels import fx_effect, holdings
from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec, iso
from investment_dashboard.readmodels.queries.overview_query import (
    InstrumentMetrics,
    MoverEntry,
    allocation_treemap,
    build_holding_cards,
    build_movers,
    compute_instrument_metrics,
    compute_market_verdict,
    holding_freshness,
)
from investment_dashboard.services import fx_service, investing_power_service, prices_service
from investment_dashboard.services.metrics_service import (
    PortfolioMetrics,
    compute_portfolio_metrics,
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
    allocation = allocation_treemap(positions)
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
        "allocation": [{"label": d.label, "value_eur": dec(d.value_eur)} for d in allocation],
    }


# -- v6 API ------------------------------------------------------------------


def _mover(entry: MoverEntry, ccy: str) -> dict[str, Any]:
    return {
        "symbol": entry.symbol,
        "name": entry.name,
        "move": dec(holdings.pick(entry.move_eur, entry.move_usd, ccy)),
        "pct": dec(holdings.pick(entry.pct_eur, entry.pct_usd, ccy)),
        "reason": entry.reason,
    }


def _currency_block(
    session: Session, metrics: PortfolioMetrics, *, now: datetime
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
    spot = fx_service.get_live_spot("USD")
    regime = fx_effect.fx_box_regime(now)
    rate_move: Decimal | None = None
    if live_fx is not None and prev_fx is not None and prev_fx > 0:
        rate_move = (live_fx - prev_fx) / prev_fx * 100
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
        # effect (EUR return minus USD return). Both returns are computed
        # independently per currency; nothing is converted.
        "return_split": {
            "total_return_eur": dec(metrics.total_growth_compounded_eur),
            "investment_return": dec(metrics.total_growth_compounded_usd),
            "currency_effect_pp": dec(lifetime.currency_effect_pp),
        },
        "today": today,
    }


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
    metrics = compute_portfolio_metrics(session, as_of=ctx.as_of)
    usd = ccy == "USD"
    pick = holdings.pick

    positions = holdings.merge_positions_by_instrument(compute_positions(session, as_of=ctx.as_of))
    instrument_metrics = compute_instrument_metrics(session, positions, as_of=ctx.as_of)
    anomalies = prices_service.instruments_with_price_anomalies(
        session, [p.instrument.id for p in positions]
    )
    cards = build_holding_cards(
        positions,
        metrics=instrument_metrics,
        freshness=holding_freshness(session, positions),
        price_anomaly_ids=anomalies,
    )
    movers = build_movers(cards, ccy)

    # Benchmark simulation is EUR-only today: a USD portfolio return must not be
    # compared with a EUR benchmark return, so the USD verdict figures are null.
    verdict = compute_market_verdict(
        session,
        portfolio_xirr=metrics.xirr,
        years=(
            years_between(metrics.first_cashflow_date, metrics.as_of)
            if metrics.first_cashflow_date
            else None
        ),
        as_of=metrics.as_of,
    )
    # Single-instant conversion of the annual fee estimate at the spot rate.
    expense_cost: Decimal | None = metrics.annual_expense_cost_eur
    if usd:
        rate = ctx.fx_rate_eur_usd
        expense_cost = expense_cost * rate if rate is not None else None

    kpis = {
        "total_value": dec(pick(metrics.total_value_eur, metrics.total_value_usd, ccy)),
        "total_invested": dec(
            pick(metrics.total_contributions_eur, metrics.total_contributions_usd, ccy)
        ),
        "capital_gain": dec(pick(metrics.capital_gain_eur, metrics.capital_gain_usd, ccy)),
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
    return {
        "ccy": ccy,
        "as_of": ctx.as_of.isoformat(),
        "generated_at": now.isoformat(),
        "fx_eur_usd": dec(ctx.fx_rate_eur_usd),
        "is_live": market_hours.is_us_market_open(now),
        "position_count": len(cards),
        "kpis": kpis,
        "currency": _currency_block(session, metrics, now=now),
        "market_verdict": {
            "benchmark_symbol": verdict.benchmark_symbol,
            "portfolio_return": None if usd else dec(verdict.portfolio_return),
            "benchmark_return": None if usd else dec(verdict.benchmark_return),
            "beating": None if usd else verdict.beating,
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
    }
