"""Schemas for ``/api/deposits``."""

from __future__ import annotations

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


class DepositsOut(ApiModel):
    ccy: Ccy
    as_of: str
    summary: DepositSummaryOut
    rows: list[DepositRowOut]
