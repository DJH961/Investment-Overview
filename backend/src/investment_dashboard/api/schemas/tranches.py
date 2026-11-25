"""Schemas for ``GET /api/holdings/{instrument_id}/tranches`` (7.1, FIFO view)."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, DecStr


class TrancheRowOut(ApiModel):
    id: int = Field(description="Id of the transaction that opened the tranche")
    account_id: int
    account_name: str
    acquired_on: str
    source: Literal["buy", "reinvest", "transfer_in"]
    quantity_bought: DecStr = Field(description="Shares bought, on today's split basis")
    quantity_left: DecStr
    cost_per_share_native: DecStr
    cost_native: DecStr = Field(description="Cost of the shares still held, native")
    age_days: int
    long_term_on: str = Field(description="Acquisition date + 1 year + 1 day")
    days_to_long_term: int | None = Field(description="Null once long-term")
    status: Literal["long", "soon", "short"] = Field(description="soon = long-term in <= 60 days")
    gain_native: DecStr | None = Field(description="Against today's price; null without a price")
    gain_pct: DecStr | None = Field(description="fraction, 0.01 = 1%")
    cost_eur: DecStr | None = Field(
        default=None,
        description=(
            "EUR cost (book) of the shares still held: the holding's cash-pool EUR "
            "shared out over its open tranches by native cost (FIFO view of an "
            "average-cost figure); under eur_basis buy_date, the native cost at the "
            "ECB fixing of the acquisition date. Null when not available."
        ),
    )
    orig_eur: DecStr | None = Field(
        default=None,
        description="Your original euros behind those shares (book minus market EUR)",
    )


class TrancheGroupOut(ApiModel):
    account_id: int
    source: Literal["reinvest"]
    count: int
    quantity_left: DecStr
    cost_native: DecStr
    avg_cost_per_share_native: DecStr | None
    gain_native: DecStr | None
    gain_pct: DecStr | None = Field(description="fraction, 0.01 = 1%")
    long_count: int
    short_count: int = Field(description="Short-term rows, the 'soon' ones included")
    row_ids: list[int]


class TrancheTotalsOut(ApiModel):
    quantity_left: DecStr
    position_quantity: DecStr
    matches_position: bool
    long_quantity: DecStr
    short_quantity: DecStr
    fully_sold_count: int


class TranchesResponse(ApiModel):
    instrument_id: int
    symbol: str
    currency: str
    method: Literal["fifo_view"] = Field(
        description="FIFO view per purchase; the holding's totals use average cost"
    )
    eur_basis: Literal["pool", "buy_date"] = Field(
        default="pool", description="Setting fx.holding_cost_basis behind cost_eur / orig_eur"
    )
    as_of: str
    price_native: DecStr | None
    rows: list[TrancheRowOut] = Field(description="Open tranches, oldest first")
    groups: list[TrancheGroupOut] = Field(description="Open reinvested tranches per account")
    totals: TrancheTotalsOut
