"""Schemas for ``GET /api/holdings``."""

from __future__ import annotations

from pydantic import Field

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr

_FRAC = "fraction, 0.01 = 1%"


class HoldingRow(ApiModel):
    instrument_id: int
    symbol: str
    name: str
    category: str
    asset_class: str
    account: str
    native_currency: str
    shares: DecStr
    avg_price_native: DecStr | None = None
    price_native: DecStr | None = None
    price_as_of: str | None = None
    updated_at: str | None = None
    price_type: str
    is_money_market: bool
    market_open: bool
    expense_ratio: DecStr | None = Field(default=None, description=f"Annual fee ({_FRAC})")
    cost_basis: DecStr | None = None
    value: DecStr | None = None
    capital_gain: DecStr | None = Field(
        default=None, description="value - cost_basis (unrealised, excludes dividends)"
    )
    dividends: DecStr | None = Field(default=None, description="Cash dividends received")
    total_return: DecStr | None = Field(
        default=None, description="capital_gain + dividends (same basis as the overview)"
    )
    xirr: DecStr | None = Field(default=None, description=f"Annualised return ({_FRAC})")
    total_growth: DecStr | None = Field(
        default=None, description=f"Compounded return since first purchase ({_FRAC})"
    )
    ytd_growth: DecStr | None = Field(default=None, description=f"Year to date ({_FRAC})")
    mtd_growth: DecStr | None = Field(default=None, description=f"Month to date ({_FRAC})")
    today_pct: DecStr | None = Field(default=None, description=f"Latest daily move ({_FRAC})")
    today_move: DecStr | None = None
    daily_growth_as_of: str | None = None
    daily_is_stale: bool
    weight_pct: DecStr | None = Field(
        default=None, description=f"Share of portfolio value ({_FRAC})"
    )
    value_warning: bool
    price_data_warning: bool


class HoldingsSummary(ApiModel):
    best_symbol: str | None = None
    best_growth: DecStr | None = Field(
        default=None, description=f"total_growth of the best holding ({_FRAC})"
    )
    worst_symbol: str | None = None
    worst_growth: DecStr | None = Field(
        default=None, description=f"total_growth of the worst holding ({_FRAC})"
    )
    most_concentrated_symbol: str | None = None
    most_concentrated_weight_pct: DecStr | None = Field(
        default=None, description=f"Largest weight ({_FRAC})"
    )
    gainers: int = Field(description="Holdings up today (daily money move > 0)")
    losers: int = Field(description="Holdings down today (daily money move < 0)")
    in_profit: int = Field(description="Holdings with capital_gain > 0 (total, not today)")
    in_loss: int = Field(description="Holdings with capital_gain < 0 (total, not today)")


class HoldingsResponse(ApiModel):
    ccy: Ccy
    as_of: str
    fx_eur_usd: DecStr | None = None
    total_value: DecStr | None = None
    total_cost_basis: DecStr | None = Field(default=None, description="Sum of cost bases")
    total_capital_gain: DecStr | None = Field(
        default=None, description="Sum of value - cost_basis over holdings"
    )
    total_dividends: DecStr | None = Field(default=None, description="Sum of dividends")
    total_return: DecStr | None = Field(
        default=None,
        description=(
            "total_capital_gain + total_dividends. Differs from the overview total_return by "
            "cash not invested in positions and gains realised on closed positions."
        ),
    )
    holdings: list[HoldingRow]
    summary: HoldingsSummary
