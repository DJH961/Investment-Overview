"""Schemas for ``/api/fx-conversions`` (Decimal as strings)."""

from __future__ import annotations

from datetime import date as date_type
from decimal import Decimal
from typing import Literal

from pydantic import Field, field_validator

from investment_dashboard.api.schemas.common import ApiModel, DecStr
from investment_dashboard.api.schemas.currency_rate import RangeWindow

Provider = Literal["wise", "revolut", "other"]
DepositStatus = Literal["matched", "partial", "ecb_only", "received_usd"]


class FxConversionIn(ApiModel):
    date: date_type
    eur_sent: Decimal = Field(gt=0)
    usd_received: Decimal = Field(gt=0)
    fees_eur: Decimal | None = Field(default=None, ge=0)
    note: str | None = Field(default=None, max_length=512)
    provider: Provider | None = None
    kept_usd: Decimal = Field(
        default=Decimal(0),
        ge=0,
        description="Dollars kept in the USD account, never sent to the broker.",
    )
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
    kept_usd: DecStr = Field(description="Dollars kept outside investing (not in the pool).")
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
    spread_eur: DecStr | None = Field(
        default=None,
        description="eur_sent - usd_received / ecb_rate; null when there is no fixing.",
    )
    cost_eur: DecStr | None = Field(
        default=None, description="spread_eur + fees_eur; positive = paid more than the ECB."
    )
    fees_usd: DecStr | None = Field(
        default=None, description="fees_eur at that conversion's own fixing."
    )
    cost_usd: DecStr | None = Field(
        default=None,
        description="Dollars not received: eur_sent * ecb_rate - usd_received + fees_usd.",
    )
    used_by: list[UsedByOut]
    remaining_usd: DecStr
    is_estimate: bool = Field(
        default=False, description="A recurring-plan estimate not yet settled (7.3, P14)."
    )


class CostSummaryOut(ApiModel):
    """Totals in the view's currency (EUR amounts, or USD amounts not received)."""

    count: int
    converted: DecStr = Field(description="EUR sent (EUR view) or USD received (USD view).")
    fees: DecStr
    spread: DecStr
    cost: DecStr = Field(description="fees + spread; negative is intraday noise, not a win.")
    cost_pct: DecStr | None = Field(description="cost / converted; null when nothing converted.")
    avg_off_pct: DecStr | None = Field(
        description="all-in distance from the ECB, weighted by EUR converted."
    )
    all_in_rate: DecStr | None = Field(
        default=None, description="sum(usd received) / sum(eur sent + fees) of the group."
    )


class CostMonthOut(CostSummaryOut):
    month: str = Field(description="YYYY-MM")


class CostYearOut(CostSummaryOut):
    year: int


class CostProviderOut(CostSummaryOut):
    provider: Provider | None


class CostRowOut(ApiModel):
    id: int
    date: str
    provider: Provider | None
    eur_sent: DecStr
    usd_received: DecStr
    ecb_rate: DecStr | None
    ecb_rate_date: str | None
    off_pct: DecStr | None
    fees: DecStr | None
    spread: DecStr | None
    cost: DecStr | None
    month_avg: DecStr | None = Field(
        description="Mean of that calendar month's settled ECB fixings (so far, if running)."
    )
    month_so_far: bool
    timing_pct: DecStr | None = Field(
        description="rate / month_avg - 1: positive = better than the month's average."
    )


class CostTimingOut(ApiModel):
    count: int
    avg_pct: DecStr | None = Field(description="Weighted by EUR converted.")
    better: int
    worse: int
    so_far: int = Field(description="Conversions whose month is still running.")


class CostPointOut(ApiModel):
    date: str
    cost: DecStr = Field(description="Cumulative cost up to and including this date.")


class CostsOut(ApiModel):
    currency: Literal["EUR", "USD"]
    range: str
    start: str | None
    unpriced: int = Field(description="Conversions with no fixing close enough; not counted.")
    summary: CostSummaryOut
    best: CostRowOut | None
    worst: CostRowOut | None
    cumulative: list[CostPointOut]
    timing: CostTimingOut
    by_year: list[CostYearOut]
    by_month: list[CostMonthOut]
    by_provider: list[CostProviderOut]
    cheaper_provider: Provider | None = Field(
        description="Lowest cost % among providers with conversions (needs two to compare)."
    )
    cheaper_than: Provider | None = Field(description="The next-cheapest provider.")
    cheaper_gap_pct: DecStr | None
    rows: list[CostRowOut]
    #: The range as dates (one meaning for the whole page, 7.3.1).
    window: RangeWindow | None = None


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
    received_in_usd: bool = Field(
        default=False, description="Marked as received in USD (no conversion)."
    )


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
