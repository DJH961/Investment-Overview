"""Schemas for ``GET /api/overview``."""

from __future__ import annotations

from pydantic import Field

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr

_FRAC = "fraction, 0.01 = 1%"


class OverviewKpis(ApiModel):
    """KPIs in the requested ccy. Ratios are fractions (``0.12`` = 12 %)."""

    total_value: DecStr | None = None
    total_invested: DecStr | None = None
    capital_gain: DecStr | None = Field(
        default=None, description="total_value - total_invested (excludes dividends)"
    )
    total_return: DecStr | None = Field(
        default=None, description="capital_gain + realized cash dividends"
    )
    dividend_income: DecStr | None = None
    dividends_ttm: DecStr | None = None
    xirr: DecStr | None = Field(
        default=None, description=f"Money-weighted annualised return ({_FRAC})"
    )
    total_growth_compounded: DecStr | None = Field(
        default=None, description=f"(1 + XIRR)^years - 1 ({_FRAC})"
    )
    ytd_growth: DecStr | None = Field(default=None, description=f"Year-to-date growth ({_FRAC})")
    ytd_xirr: DecStr | None = Field(default=None, description=f"Year-to-date XIRR ({_FRAC})")
    mtd_growth: DecStr | None = Field(default=None, description=f"Month-to-date growth ({_FRAC})")
    daily_growth_pct: DecStr | None = Field(
        default=None, description=f"Latest daily move ({_FRAC})"
    )
    daily_move: DecStr | None = None
    daily_growth_as_of: str | None = None
    weighted_expense_ratio: DecStr | None = Field(
        default=None, description=f"Weighted expense ratio ({_FRAC})"
    )
    annual_expense_cost: DecStr | None = None
    dividend_yield_pct: DecStr | None = Field(
        default=None, description=f"Dividend yield on income to date ({_FRAC})"
    )
    dividend_yield_ttm_pct: DecStr | None = Field(
        default=None, description=f"Trailing-12-month dividend yield ({_FRAC})"
    )


class CurrencyLifetime(ApiModel):
    avg_invest_rate: DecStr | None = None
    current_rate: DecStr | None = None
    rate_change_pct: DecStr | None = Field(
        default=None, description=f"Current rate vs average invest rate ({_FRAC})"
    )
    fx_pnl_eur: DecStr | None = None
    repatriation_value_eur: DecStr | None = None
    breakeven_rate: DecStr | None = None


class ReturnSplit(ApiModel):
    """Investment return (USD wallet) vs currency effect; independent, never converted."""

    total_return_eur: DecStr | None = Field(
        default=None, description=f"Compounded EUR return ({_FRAC})"
    )
    investment_return: DecStr | None = Field(
        default=None, description=f"Investment return in the USD wallet ({_FRAC})"
    )
    currency_effect_pp: DecStr | None = Field(
        default=None, description="EUR return minus USD return, in percentage points"
    )


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
    rate_move_pct: DecStr | None = Field(
        default=None, description=f"EUR/USD move vs previous close ({_FRAC})"
    )
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
    portfolio_return: DecStr | None = Field(
        default=None, description=f"Portfolio compounded return ({_FRAC})"
    )
    benchmark_return: DecStr | None = Field(
        default=None, description=f"Benchmark compounded return ({_FRAC})"
    )
    beating: bool | None = None


class Mover(ApiModel):
    symbol: str
    name: str
    move: DecStr | None = None
    pct: DecStr | None = Field(
        default=None, description=f"Move vs previous close in the reporting currency ({_FRAC})"
    )
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
