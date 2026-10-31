"""Schemas for ``GET /api/holdings``."""

from __future__ import annotations

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr


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
    expense_ratio: DecStr | None = None
    cost_basis: DecStr | None = None
    value: DecStr | None = None
    capital_gain: DecStr | None = None
    xirr: DecStr | None = None
    total_growth: DecStr | None = None
    ytd_growth: DecStr | None = None
    mtd_growth: DecStr | None = None
    today_pct: DecStr | None = None
    today_move: DecStr | None = None
    daily_growth_as_of: str | None = None
    daily_is_stale: bool
    weight_pct: DecStr | None = None
    value_warning: bool
    price_data_warning: bool


class HoldingsSummary(ApiModel):
    best_symbol: str | None = None
    best_growth: DecStr | None = None
    worst_symbol: str | None = None
    worst_growth: DecStr | None = None
    most_concentrated_symbol: str | None = None
    most_concentrated_weight_pct: DecStr | None = None
    gainers: int
    losers: int


class HoldingsResponse(ApiModel):
    ccy: Ccy
    as_of: str
    fx_eur_usd: DecStr | None = None
    total_value: DecStr | None = None
    total_capital_gain: DecStr | None = None
    holdings: list[HoldingRow]
    summary: HoldingsSummary
