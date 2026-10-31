"""Overview read-model — KPIs, per-instrument positions, and allocation.

Built entirely on top of the shared compute layer
(:mod:`investment_dashboard.services.metrics_service`,
:mod:`investment_dashboard.services.positions_service`) so the numbers
are identical to what the NiceGUI overview page renders.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services import prices_service
from investment_dashboard.services.metrics_service import (
    PortfolioMetrics,
    compute_portfolio_metrics,
)
from investment_dashboard.services.positions_service import Position, compute_positions
from investment_dashboard.ui.pages._overview_query import (
    InstrumentMetrics,
    allocation_treemap,
    compute_instrument_metrics,
)

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
