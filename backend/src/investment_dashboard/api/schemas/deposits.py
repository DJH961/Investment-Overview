"""Schemas for ``/api/deposits``."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, Ccy, DecStr


class DepositSummaryOut(ApiModel):
    total_contrib: DecStr | None
    ytd_contrib: DecStr | None
    mtd_contrib: DecStr | None
    total_contrib_native: DecStr | None


class ConversionBatchOut(ApiModel):
    """The slice of one currency conversion that paid for (part of) a deposit."""

    conversion_id: int
    date: str
    usd: DecStr
    eur: DecStr


class DepositRowOut(ApiModel):
    id: int | None
    date: str
    account: str
    kind: str
    amount_native: DecStr
    currency: str
    amount: DecStr | None = Field(
        description="Amount in the requested ccy at the transaction date; null when underivable"
    )
    amount_other: DecStr | None = Field(
        default=None, description="Same cashflow in the other reporting currency, trade-date rate"
    )
    description: str
    effective_rate: DecStr | None = Field(
        default=None,
        description="USD per EUR actually paid for a USD deposit; null without conversions",
    )
    rate_source: str | None = Field(
        default=None,
        description='"conversions", "ecb" (pool did not cover it), "mixed"; null without conversions',
    )
    conversion_batches: list[ConversionBatchOut] = Field(default_factory=list)


class DepositYearOut(ApiModel):
    year: int
    count: int
    total: DecStr = Field(description="Net contributions that year in ccy (sum of trade-date legs)")
    total_other: DecStr


class DepositsOut(ApiModel):
    ccy: Ccy
    other_ccy: Ccy
    as_of: str
    summary: DepositSummaryOut = Field(description="Whole ledger; ignores the row filters")
    summary_other: DepositSummaryOut
    years: list[int] = Field(description="Years with cash flows (unfiltered), newest first")
    by_year: list[DepositYearOut] = Field(description="Of the filtered rows, newest year first")
    rows: list[DepositRowOut]


class DividendRowOut(ApiModel):
    id: int | None
    date: str
    symbol: str
    account: str
    kind: Literal["cash", "reinvest", "interest"]
    amount_native: DecStr | None
    currency: str
    amount: DecStr | None = Field(description="In ccy at the payment date's rate")
    amount_other: DecStr | None


class DividendYearOut(ApiModel):
    year: int
    count: int
    dividends: DecStr
    interest: DecStr
    dividends_other: DecStr
    interest_other: DecStr


class DividendHoldingOut(ApiModel):
    symbol: str
    name: str
    count: int
    lifetime: DecStr
    ttm: DecStr
    lifetime_other: DecStr
    ttm_other: DecStr
    last_date: str


class DividendsOut(ApiModel):
    ccy: Ccy
    other_ccy: Ccy
    as_of: str
    lifetime_total: DecStr
    lifetime_total_other: DecStr
    ttm_total: DecStr = Field(description="Dividends dated in the last 12 months (no interest)")
    ttm_total_other: DecStr
    yield_ttm: DecStr | None = Field(
        default=None, description="Trailing-12-month yield, fraction (same as the Overview)"
    )
    yield_lifetime: DecStr | None = Field(
        default=None, description="Lifetime dividends / value, fraction"
    )
    by_year: list[DividendYearOut]
    by_holding: list[DividendHoldingOut]
    rows: list[DividendRowOut]
