"""Schemas for ``/api/recurring`` (recurring plans and their est. rows; Decimal as strings)."""

from __future__ import annotations

from datetime import date as date_type
from decimal import Decimal
from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, DecStr

PlanKind = Literal["buy", "deposit", "conversion"]
Unit = Literal["days", "weeks", "months"]
Provider = Literal["wise", "revolut", "other"]
PlanStatus = Literal["active", "paused", "ended"]
RowType = Literal["transaction", "fx_conversion"]


class PlanIn(ApiModel):
    kind: PlanKind
    unit: Unit
    every: int = Field(ge=1, le=366)
    anchor: int | None = Field(
        default=None,
        description="Weekday 0-6 (Monday = 0) for weeks, day of month 1-31 for months.",
    )
    start_date: date_type
    end_date: date_type | None = None
    account_id: int | None = Field(default=None, description="Buy plans.")
    instrument_id: int | None = Field(default=None, description="Buy plans.")
    amount: Decimal | None = Field(
        default=None, gt=0, description="Buy: native amount per run; conversion: EUR sent."
    )
    shares: Decimal | None = Field(default=None, gt=0, description="Buy plans, instead of amount.")
    provider: Provider | None = Field(default=None, description="Conversion plans.")
    expected_fee: Decimal | None = Field(
        default=None,
        ge=0,
        description=(
            "Conversion plans: EUR fee per run. Defaults to the last real conversion's fee "
            "with that provider."
        ),
    )


class PlanOut(ApiModel):
    id: int
    kind: PlanKind
    unit: Unit
    every: int
    anchor: int | None
    start_date: str
    end_date: str | None
    status: PlanStatus
    paused: bool
    account_id: int | None
    account: str | None
    instrument_id: int | None
    symbol: str | None
    amount: DecStr | None
    shares: DecStr | None
    provider: Provider | None
    expected_fee: DecStr | None
    next_due: str | None = Field(description="Next due date still to be handled; null if none.")
    note: str | None = Field(
        default=None,
        description="One-line caution, e.g. a buy plan whose account has no settlement fund.",
    )


class EstimateOut(ApiModel):
    row_type: RowType
    id: int
    plan_id: int | None
    due_date: str | None
    date: str
    label: str = Field(description="Account for a buy, provider for a conversion.")
    symbol: str | None
    currency: str | None
    price: DecStr | None
    quantity: DecStr | None
    total: DecStr | None
    fees: DecStr | None
    sent: DecStr | None
    received: DecStr | None
    price_dp: int = Field(
        default=4, description="Decimals the ledger holds for this price (what a stepper moves)."
    )
    quantity_dp: int = Field(default=4, description="Same for the quantity.")


class ReminderGroupOut(ApiModel):
    plan_id: int | None
    kind: Literal["buy", "conversion"]
    count: int
    input: Literal["type", "import"] = Field(
        description="What settles them: type the figures (conversions) or import the file (buys)."
    )
    message: str = Field(description="One plain sentence for this plan; never one per row.")


class EstimatesOut(ApiModel):
    count: int = Field(
        description=(
            "Estimated rows still to settle (the badge number). A buy and its core-fund "
            "leg are one; deposits need no input and are never counted."
        )
    )
    rows: list[EstimateOut]
    groups: list[ReminderGroupOut] = Field(description="The reminder, one line per plan.")


class SuggestionOut(ApiModel):
    kind: PlanKind
    unit: Unit
    every: int
    anchor: int | None
    amount: DecStr
    occurrences: int = Field(description="How many past rows the suggestion is based on.")
    account_id: int | None = None
    account: str | None = None
    instrument_id: int | None = None
    symbol: str | None = None
    provider: Provider | None = None


class SettleRowIn(ApiModel):
    row_type: RowType
    id: int
    price: Decimal | None = Field(default=None, gt=0)
    quantity: Decimal | None = Field(default=None, gt=0)
    total: Decimal | None = Field(default=None, gt=0)
    fees: Decimal | None = Field(default=None, ge=0)
    sent: Decimal | None = Field(default=None, gt=0)
    received: Decimal | None = Field(default=None, gt=0)


class SettleIn(ApiModel):
    rows: list[SettleRowIn] = Field(default_factory=list)
    due_date: date_type | None = Field(
        default=None, description="Also settle (as estimated) every est. row of this due date."
    )


class SettleOut(ApiModel):
    settled: int
    remaining: int
