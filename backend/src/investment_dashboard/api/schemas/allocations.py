"""Schemas for ``/api/allocations``."""

from __future__ import annotations

from pydantic import Field

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr

_FRAC = "fraction, 0.01 = 1%"


class TargetItem(ApiModel):
    instrument_id: int
    symbol: str
    weight_pct: DecStr = Field(description=f"Target weight ({_FRAC})")
    no_buy: bool = False


class TargetOut(ApiModel):
    id: int
    name: str
    active: bool
    allow_sell: bool
    display_currency: str | None = None
    items: list[TargetItem]


class DriftRow(ApiModel):
    key: str
    instrument_id: int
    label: str
    category: str
    asset_class: str
    current_pct: DecStr = Field(description=f"Current weight ({_FRAC})")
    target_pct: DecStr = Field(description=f"Target weight ({_FRAC})")
    drift_pp: DecStr = Field(
        description="current - target in percentage points (1.5 = 1.5 pp); positive = over"
    )
    current_value: DecStr | None = None
    #: Target value minus current value; positive = buy, negative = sell.
    delta_value: DecStr | None = None


class Bucket(ApiModel):
    label: str
    value: DecStr | None = None
    pct: DecStr = Field(description=f"Share of total value ({_FRAC})")


class AllocationsResponse(ApiModel):
    ccy: Ccy
    as_of: str
    total_value: DecStr | None = None
    targets: list[TargetOut]
    active_target_id: int | None = None
    drift: list[DriftRow]
    current_by_category: list[Bucket]
    current_by_asset_class: list[Bucket]


class TargetItemIn(ApiModel):
    instrument_id: int
    weight_pct: DecStr = Field(
        description="Relative weight; all weights are normalised (fractions or percent both work)"
    )
    no_buy: bool = False


class TargetIn(ApiModel):
    """Create (no ``id``) or replace (with ``id``) a saved target; weights are normalised."""

    id: int | None = None
    name: str = Field(min_length=1, max_length=128)
    active: bool = False
    allow_sell: bool = False
    display_currency: Ccy | None = None
    items: list[TargetItemIn]


class PlanRowOut(ApiModel):
    instrument_id: int
    symbol: str
    name: str
    target_pct: DecStr = Field(description=f"Target weight ({_FRAC})")
    current_value: DecStr | None = None
    add_value: DecStr | None = None
    current_price: DecStr | None = None
    add_shares: DecStr
    no_buy: bool


class RebalanceResponse(ApiModel):
    ccy: Ccy
    target_id: int
    target_name: str
    cash_to_invest: DecStr | None = None
    residual_cash: DecStr | None = None
    allow_sell: bool
    allow_fractional: bool
    fx_eur_usd: DecStr | None = None
    rows: list[PlanRowOut]
