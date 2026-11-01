"""Schemas for ``/api/deposits``."""

from __future__ import annotations

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, Ccy, DecStr


class DepositSummaryOut(ApiModel):
    total_contrib: DecStr | None
    ytd_contrib: DecStr | None
    mtd_contrib: DecStr | None
    total_contrib_native: DecStr | None


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
    #: Reserved for the FIFO match fields (filled by the currency-conversion work).
    effective_rate: DecStr | None = None
    rate_source: str | None = None


class DepositsOut(ApiModel):
    ccy: Ccy
    as_of: str
    summary: DepositSummaryOut
    rows: list[DepositRowOut]
