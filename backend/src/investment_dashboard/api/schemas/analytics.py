"""Schemas for ``/api/analytics``."""

from __future__ import annotations

from investment_dashboard.api.schemas.common import ApiModel, Ccy, DecStr


class CurvePointOut(ApiModel):
    date: str
    portfolio_value: DecStr | None
    cumulative_contributions: DecStr | None
    benchmark_value: DecStr | None


class AttributionOut(ApiModel):
    instrument_id: int
    symbol: str
    start_value: DecStr | None
    end_value: DecStr | None
    net_contribution: DecStr | None
    absolute_pnl: DecStr | None
    pct_of_total_return: DecStr | None


class AnalyticsOut(ApiModel):
    ccy: Ccy
    currency: str
    as_of: str
    start: str
    curve_start: str
    cagr: DecStr | None
    twr: DecStr | None
    xirr: DecStr | None
    volatility: DecStr | None
    sharpe: DecStr | None
    sortino: DecStr | None
    max_drawdown: DecStr | None
    calmar: DecStr | None
    ulcer: DecStr | None
    var_95: DecStr | None
    cvar_95: DecStr | None
    skew: DecStr | None
    kurtosis: DecStr | None
    beta: DecStr | None
    alpha: DecStr | None
    risk_free_rate: DecStr | None
    risk_free_symbol: str
    benchmark_symbol: str
    benchmark_is_funded: bool
    curve: list[CurvePointOut]
    #: Attribution is computed on EUR marks only: empty (and
    #: ``attribution_currency`` null) when ``ccy`` is not EUR.
    attribution: list[AttributionOut]
    attribution_currency: str | None
