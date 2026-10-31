"""Schemas for ``/api/fx-conversions`` (Decimal as strings)."""

from __future__ import annotations

from datetime import date as date_type
from decimal import Decimal

from pydantic import Field, field_validator

from investment_dashboard.api.schemas.common import ApiModel, DecStr


class FxConversionIn(ApiModel):
    date: date_type
    eur_sent: Decimal = Field(gt=0)
    usd_received: Decimal = Field(gt=0)
    fees_eur: Decimal | None = Field(default=None, ge=0)
    note: str | None = Field(default=None, max_length=512)

    @field_validator("date")
    @classmethod
    def _not_future(cls, value: date_type) -> date_type:
        if value > date_type.today():
            raise ValueError("date must not be in the future")
        return value


class FxConversionOut(ApiModel):
    id: int
    date: str
    eur_sent: DecStr
    usd_received: DecStr
    fees_eur: DecStr | None
    note: str | None
    effective_rate: DecStr = Field(description="USD received per EUR sent (derived).")


class SliceOut(ApiModel):
    conversion_id: int
    usd: DecStr
    eur: DecStr


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
