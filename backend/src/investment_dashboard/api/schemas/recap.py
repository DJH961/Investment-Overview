"""Schemas for ``GET /api/recap`` and ``POST /api/recap/ack`` (7.4 P8)."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, DecStr

_FRAC = "fraction, 0.01 = 1%"


class RecapSide(ApiModel):
    """One period in one reporting currency (``null`` = not available)."""

    contributed: DecStr | None = Field(description="The Periods row's contributions")
    cashed_out: DecStr = Field(description="Received back in euros (0 until cash-outs exist)")
    market: DecStr | None = Field(description="Market part of the bridge (incl. dividends)")
    currency: DecStr | None = Field(description="Currency part of the bridge")
    dividends: DecStr | None
    interest: DecStr | None
    conversion_cost: DecStr | None = Field(
        description="Fees + spread against the ECB fixing of the period's conversions"
    )
    conversions: int = Field(description="Conversions dated in the period")
    opening_value: DecStr | None
    closing_value: DecStr | None
    nominal_return: DecStr | None = Field(description=f"The Periods row's growth ({_FRAC})")
    real_return: DecStr | None = Field(
        description=f"Nominal EUR return deflated by euro-area HICP ({_FRAC}); EUR only"
    )
    real_to: str | None = Field(description="Last HICP month (YYYY-MM) the real return covers")


class RecapOut(ApiModel):
    period: str = Field(description="YYYY-MM or YYYY")
    granularity: Literal["month", "year"]
    start: str
    end: str
    is_complete: bool
    has_data: bool
    due: bool = Field(description="Show on the Overview: a new period not yet dismissed")
    default_period: str
    last_ack: str | None
    EUR: RecapSide
    USD: RecapSide


class RecapAckIn(ApiModel):
    period: str | None = Field(
        default=None,
        pattern=r"^\d{4}(-(0[1-9]|1[0-2]))?$",
        description="The period dismissed (default: the current default period)",
    )


class RecapAckOut(ApiModel):
    last_ack: str
