"""Analytics read-model — equity curve, risk metrics, and attribution.

Wraps the shared :func:`investment_dashboard.ui.pages._analytics_query.build_bundle`.
Every figure that can't be computed (sparse history, no benchmark cache,
no risk-free rate) is serialized as ``null``.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain.attribution import AttributionRow
from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.ui.pages._analytics_query import (
    AnalyticsBundle,
    EquityCurvePoint,
    build_bundle,
)


def _curve_point(p: EquityCurvePoint) -> dict[str, Any]:
    return {
        "date": p.date.isoformat(),
        "portfolio_value": dec(p.portfolio_value),
        "cumulative_contributions": dec(p.cumulative_contributions),
        "benchmark_value": dec(p.benchmark_value),
    }


def _attribution_row(r: AttributionRow) -> dict[str, Any]:
    return {
        "instrument_id": r.instrument_id,
        "symbol": r.symbol,
        "start_value": dec(r.start_value),
        "end_value": dec(r.end_value),
        "net_contribution": dec(r.net_contribution),
        "absolute_pnl": dec(r.absolute_pnl),
        "pct_of_total_return": dec(r.pct_of_total_return),
    }


def _bundle_dict(b: AnalyticsBundle) -> dict[str, Any]:
    return {
        "as_of": b.as_of.isoformat(),
        "start": b.start.isoformat(),
        "currency": b.currency,
        "cagr": dec(b.cagr),
        "twr": dec(b.twr),
        "xirr": dec(b.xirr),
        "volatility": dec(b.volatility),
        "sharpe": dec(b.sharpe),
        "sortino": dec(b.sortino),
        "max_drawdown": dec(b.max_drawdown),
        "calmar": dec(b.calmar),
        "ulcer": dec(b.ulcer),
        "var_95": dec(b.var_95),
        "cvar_95": dec(b.cvar_95),
        "skew": dec(b.skew),
        "kurtosis": dec(b.kurtosis),
        "beta": dec(b.beta),
        "alpha": dec(b.alpha),
        "risk_free_rate": dec(b.risk_free_rate),
        "risk_free_symbol": b.risk_free_symbol,
        "benchmark_symbol": b.benchmark_symbol,
        "curve": [_curve_point(p) for p in b.curve],
        "attribution": [_attribution_row(r) for r in b.attribution],
    }


def build(
    session: Session,
    *,
    context: ReadModelContext | None = None,
    lookback_days: int = 365,
) -> dict[str, Any]:
    """Return the JSON-serializable analytics read-model."""
    ctx = context or build_context(session)
    # The equity curve must be exported in EUR — the live-web companion is
    # EUR-native (every ``*_eur`` figure, the live total, and the per-holding
    # marks are all EUR) and converts to the user's chosen display currency at
    # render time. Exporting the curve in the desktop's display currency made
    # the web double-convert it, inflating the line by the EUR→display factor
    # and dragging a ~16% cliff onto the value chart where the (correctly-EUR)
    # live tip joined the (display-currency) history. Risk/return metrics are
    # scale-invariant, so EUR vs display currency does not change them.
    bundle = build_bundle(
        session,
        currency="EUR",
        lookback_days=lookback_days,
        as_of=ctx.as_of,
    )
    return _bundle_dict(bundle)
