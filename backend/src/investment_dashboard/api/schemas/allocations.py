"""Schemas for ``/api/allocations``."""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

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


class CategoryDriftRow(ApiModel):
    """The active target's drift summed per category (its funds' rows added up)."""

    key: str
    label: str
    #: Funds of this category in the drift table.
    funds: int
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
    drift_by_category: list[CategoryDriftRow] = Field(default_factory=list)
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


# -- POST /allocations/plan (builder mix, not saved) ---------------------------


class FundWeightIn(ApiModel):
    instrument_id: int
    weight: Decimal = Field(ge=0, description="Relative weight; normalised to 100 %")
    no_buy: bool = False


class CategoryWeightIn(ApiModel):
    name: str
    weight: Decimal = Field(ge=0, description="Relative weight; normalised to 100 %")
    split: Literal["value", "even"] = Field(
        default="value", description="Split across ticked funds: fair by value, or evenly"
    )
    selected: list[int] = Field(default_factory=list, description="Ticked member funds")


class PlanRequest(ApiModel):
    amount: Decimal = Field(ge=0, description="Cash to invest, in `ccy`.")
    ccy: Ccy = "EUR"
    fractional: bool = False
    allow_sell: bool = False
    mode: Literal["fund", "category"] = "fund"
    fund_weights: list[FundWeightIn] = Field(default_factory=list)
    category_weights: list[CategoryWeightIn] = Field(default_factory=list)


class PlanSummaryOut(ApiModel):
    cash: DecStr | None = None
    buying: DecStr | None = None
    selling: DecStr | None = None
    leftover: DecStr | None = None
    other_ccy: Ccy
    other_cash: DecStr | None = None
    other_buying: DecStr | None = None
    other_selling: DecStr | None = None
    other_leftover: DecStr | None = None
    pct_of_wealth: DecStr | None = Field(
        default=None, description=f"Cash as a share of current portfolio value ({_FRAC})"
    )


class BuilderPlanRowOut(ApiModel):
    instrument_id: int
    symbol: str
    name: str
    category: str
    target_pct: DecStr = Field(description=f"Target weight ({_FRAC})")
    current_pct: DecStr = Field(description=f"Share of the whole portfolio today ({_FRAC})")
    before_pct: DecStr = Field(
        description=f"Current value as a share of the plan total after ({_FRAC})"
    )
    after_pct: DecStr = Field(description=f"Share of the plan total after the plan ({_FRAC})")
    current_value: DecStr | None = None
    add_value: DecStr | None = Field(default=None, description="Signed: + buy, - sell")
    current_price: DecStr | None = None
    add_shares: DecStr
    no_buy: bool
    held_unticked: bool = Field(description="Held but un-ticked fund credited to its category")


class PlanCategoryOut(ApiModel):
    name: str
    target_pct: DecStr
    current_pct: DecStr
    before_pct: DecStr
    after_pct: DecStr
    add_value: DecStr | None = None


class PlanResponse(ApiModel):
    ccy: Ccy
    mode: Literal["fund", "category"]
    allow_sell: bool
    allow_fractional: bool
    fx_usd_per_eur: DecStr | None = None
    summary: PlanSummaryOut
    rows: list[BuilderPlanRowOut]
    categories: list[PlanCategoryOut]
    extras: list[str] = Field(description="Held but un-ticked funds credited to their category")
