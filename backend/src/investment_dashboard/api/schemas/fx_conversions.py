"""Schemas for ``/api/fx-conversions`` (Decimal as strings)."""

from __future__ import annotations

from datetime import date as date_type
from decimal import Decimal
from typing import Literal

from pydantic import Field, field_validator

from investment_dashboard.api.schemas.common import ApiModel, DecStr

Provider = Literal["wise", "revolut", "other"]
DepositStatus = Literal["matched", "partial", "ecb_only"]


class FxConversionIn(ApiModel):
    date: date_type
    eur_sent: Decimal = Field(gt=0)
    usd_received: Decimal = Field(gt=0)
    fees_eur: Decimal | None = Field(default=None, ge=0)
    note: str | None = Field(default=None, max_length=512)
    provider: Provider | None = None
    from_ccy: str = Field(default="EUR", min_length=3, max_length=3)
    to_ccy: str = Field(default="USD", min_length=3, max_length=3)

    @field_validator("date")
    @classmethod
    def _not_future(cls, value: date_type) -> date_type:
        if value > date_type.today():
            raise ValueError("date must not be in the future")
        return value


class UsedByOut(ApiModel):
    deposit_id: int
    date: str
    usd: DecStr
    eur: DecStr
    pinned: bool


class FxConversionOut(ApiModel):
    id: int
    date: str
    eur_sent: DecStr
    usd_received: DecStr
    fees_eur: DecStr | None
    note: str | None
    effective_rate: DecStr = Field(description="USD received per EUR sent (derived).")
    from_ccy: str
    to_ccy: str
    provider: Provider | None
    rate: DecStr = Field(description="usd_received / eur_sent (same as effective_rate).")
    all_in_rate: DecStr = Field(description="usd_received / (eur_sent + fees).")
    ecb_rate: DecStr | None = Field(
        description=(
            "Settled fixing dated that day; on a weekend or holiday the last settled fixing "
            "before it (up to a week back). Null when there is none."
        )
    )
    ecb_rate_date: str | None = Field(
        default=None,
        description="Date the fixing is from; differs from the conversion date on a weekend.",
    )
    off_pct: DecStr | None = Field(
        default=None,
        description=(
            "all_in_rate / ecb_rate - 1: negative means fewer dollars per euro than the "
            "ECB daily reference. Null when the fixing is not published."
        ),
    )
    used_by: list[UsedByOut]
    remaining_usd: DecStr


class SliceOut(ApiModel):
    conversion_id: int
    usd: DecStr
    eur: DecStr


class DepositSliceOut(ApiModel):
    conversion_id: int
    conversion_date: str
    usd: DecStr
    eur: DecStr
    rate: DecStr = Field(description="The conversion's all-in USD per EUR.")
    pinned: bool


class RejectedPinOut(ApiModel):
    deposit_id: int
    conversion_id: int
    usd: DecStr
    reason: str


class PinIn(ApiModel):
    conversion_id: int
    usd: Decimal = Field(gt=0)


class PinsIn(ApiModel):
    pins: list[PinIn]


class ReferenceOut(ApiModel):
    date: str
    ecb_rate: DecStr | None
    #: Date the fixing is from (the last settled one before ``date`` on a weekend).
    ecb_rate_date: str | None = None
    #: True when the fixing is dated exactly ``date``.
    published: bool


class DepositMatchOut(ApiModel):
    transaction_id: int
    date: str
    usd: DecStr
    matched: list[SliceOut]
    fallback_usd: DecStr
    fallback_eur: DecStr
    fallback_rate: DecStr | None
    fallback_to_ecb: bool
    rate_missing: bool
    eur_actual: DecStr
    effective_rate: DecStr | None
    status: DepositStatus
    slices: list[DepositSliceOut]
    fallback_rate_date: str | None
    pinned: bool


class RemainingBatchOut(ApiModel):
    conversion_id: int
    usd: DecStr
    eur: DecStr


class PoolOut(ApiModel):
    balance_usd: DecStr
    balance_eur: DecStr
    remaining: list[RemainingBatchOut]
    deposits: list[DepositMatchOut]
    fallbacks: list[DepositMatchOut]
    rejected_pins: list[RejectedPinOut]
