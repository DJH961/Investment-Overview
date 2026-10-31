"""Schemas for ``GET /api/overview``."""

from __future__ import annotations

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr


class OverviewKpis(ApiModel):
    """KPIs in the requested ccy. Ratios are fractions (``0.12`` = 12 %)."""

    total_value: DecStr | None = None
    total_invested: DecStr | None = None
    capital_gain: DecStr | None = None
    dividend_income: DecStr | None = None
    dividends_ttm: DecStr | None = None
    xirr: DecStr | None = None
    total_growth_compounded: DecStr | None = None
    ytd_growth: DecStr | None = None
    ytd_xirr: DecStr | None = None
    mtd_growth: DecStr | None = None
    daily_growth_pct: DecStr | None = None
    daily_move: DecStr | None = None
    daily_growth_as_of: str | None = None
    weighted_expense_ratio: DecStr | None = None
    annual_expense_cost: DecStr | None = None
    dividend_yield_pct: DecStr | None = None
    dividend_yield_ttm_pct: DecStr | None = None


class CurrencyLifetime(ApiModel):
    avg_invest_rate: DecStr | None = None
    current_rate: DecStr | None = None
    rate_change_pct: DecStr | None = None
    fx_pnl_eur: DecStr | None = None
    repatriation_value_eur: DecStr | None = None
    breakeven_rate: DecStr | None = None


class ReturnSplit(ApiModel):
    """Investment return (USD wallet) vs currency effect; independent, never converted."""

    total_return_eur: DecStr | None = None
    investment_return: DecStr | None = None
    currency_effect_pp: DecStr | None = None


class FxRegime(ApiModel):
    market_open: bool
    forex_open: bool
    holiday: bool
    forex_frozen: bool
    weekend_overnight: bool
    single_overnight: bool
    session_view: bool


class FxLegs(ApiModel):
    net: DecStr | None = None
    market_hours: DecStr | None = None
    overnight: DecStr | None = None


class InvestingPower(FxLegs):
    amount_eur: DecStr | None = None


class CurrencyToday(ApiModel):
    spot: DecStr | None = None
    prev: DecStr | None = None
    rate_move_pct: DecStr | None = None
    spot_observed_at: str | None = None
    regime: FxRegime
    reopen_at: str | None = None
    effect_eur: FxLegs | None = None
    investing_power_usd: InvestingPower | None = None


class CurrencyBlock(ApiModel):
    lifetime: CurrencyLifetime
    return_split: ReturnSplit
    today: CurrencyToday


class MarketVerdict(ApiModel):
    benchmark_symbol: str
    portfolio_return: DecStr | None = None
    benchmark_return: DecStr | None = None
    beating: bool | None = None


class Mover(ApiModel):
    symbol: str
    name: str
    move: DecStr | None = None
    pct: DecStr | None = None
    reason: str


class Movers(ApiModel):
    basis_date: str | None = None
    eligible_count: int
    winners: list[Mover]
    losers: list[Mover]


class OverviewWarnings(ApiModel):
    zero_value: list[str]
    bad_history: list[str]
    missing_fx: list[str]


class OverviewResponse(ApiModel):
    ccy: Ccy
    as_of: str
    generated_at: str
    fx_eur_usd: DecStr | None = None
    is_live: bool
    position_count: int
    kpis: OverviewKpis
    currency: CurrencyBlock
    market_verdict: MarketVerdict
    movers: Movers
    warnings: OverviewWarnings
