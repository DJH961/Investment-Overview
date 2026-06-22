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
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import benchmark_service
from investment_dashboard.ui.pages._analytics_query import (
    AnalyticsBundle,
    EquityCurvePoint,
    _build_curve,
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
    full_history_curve: bool = False,
) -> dict[str, Any]:
    """Return the JSON-serializable analytics read-model.

    Risk/return metrics (and the ``start`` field that labels their window) are
    always computed over ``lookback_days``. When ``full_history_curve`` is set,
    the equity ``curve`` alone is rebuilt from the portfolio's inception so the
    value-over-time chart can offer an honest "All" range and the cumulative
    contributions line accumulates from the very first deposit (otherwise, over
    a 1-year window, it starts at zero and reads as a flatline next to a large
    pre-existing portfolio). Risk metrics deliberately stay on the shorter
    window; only the drawn curve grows. ``curve_start`` records the curve's
    actual first date for callers that want it.
    """
    ctx = context or build_context(session)
    # The equity curve must be exported in EUR — the live-web companion carries
    # every figure in EUR as its internal FX-pivot (the ``*_eur`` figures, the
    # live total, and the per-holding marks are all EUR; USD remains the native
    # booked currency, preserved losslessly elsewhere) and converts to the user's
    # chosen display currency at render time. Exporting the curve in the desktop's
    # display currency made
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
    result = _bundle_dict(bundle)
    result["curve_start"] = bundle.start.isoformat()
    if full_history_curve:
        inception = transactions_repo.earliest_transaction_date(session)
        if inception is not None and inception < bundle.start:
            benchmark_series = benchmark_service.get_series(session, start=inception, end=ctx.as_of)
            full_curve = _build_curve(
                session,
                start=inception,
                end=ctx.as_of,
                currency="EUR",
                benchmark_closes=benchmark_series.closes,
            )
            result["curve"] = [_curve_point(p) for p in full_curve]
            result["curve_start"] = inception.isoformat()
    return result
