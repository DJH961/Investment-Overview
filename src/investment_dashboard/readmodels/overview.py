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
from investment_dashboard.services.metrics_service import (
    PortfolioMetrics,
    compute_portfolio_metrics,
)
from investment_dashboard.services.positions_service import Position, compute_positions
from investment_dashboard.ui.pages._overview_query import allocation_treemap

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
    }


def _position_dict(p: Position) -> dict[str, Any]:
    eff = p.effective
    name = (eff.name if eff is not None else p.instrument.name) or ""
    asset_class = (eff.asset_class if eff is not None else p.instrument.asset_class) or ""
    avg_price = (p.cost_basis_native / p.shares) if p.shares else None
    growth_pct: Decimal | None = None
    if p.cost_basis_native != ZERO:
        growth_pct = (p.current_value_native - p.cost_basis_native) / p.cost_basis_native
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
        "cost_basis_native": dec(p.cost_basis_native),
        "current_value_native": dec(p.current_value_native),
        "current_value_eur": dec(p.current_value_eur),
        "cumulative_dividends_cash_native": dec(p.cumulative_dividends_cash_native),
        "total_growth_pct": dec(growth_pct),
    }


def build(session: Session, *, context: ReadModelContext | None = None) -> dict[str, Any]:
    """Return the JSON-serializable overview read-model."""
    ctx = context or build_context(session)
    metrics = compute_portfolio_metrics(session, as_of=ctx.as_of)
    positions = compute_positions(session, as_of=ctx.as_of)
    allocation = allocation_treemap(positions)
    return {
        "metrics": _metrics_dict(metrics),
        "positions": [_position_dict(p) for p in positions],
        "allocation": [{"label": d.label, "value_eur": dec(d.value_eur)} for d in allocation],
    }
