"""Schemas for ``/api/periods``."""

from __future__ import annotations

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, Ccy, DecStr


class PeriodRowOut(ApiModel):
    """One period in the requested reporting currency (``null`` = not available)."""

    label: str
    is_current: bool
    contributions: DecStr | None
    dividends: DecStr | None
    interest: DecStr | None
    net_flow: DecStr | None
    opening_value: DecStr | None
    closing_value: DecStr | None
    growth_pct: DecStr | None = Field(description="Period growth (fraction, 0.01 = 1%)")
    total_growth_compounded: DecStr | None = Field(
        description="Cumulative compounded growth (fraction, 0.01 = 1%)"
    )
    period_growth_xirr: DecStr | None = Field(description="Period XIRR (fraction, 0.01 = 1%)")


class PeriodsOut(ApiModel):
    ccy: Ccy
    as_of: str
    granularity: str
    rows: list[PeriodRowOut]
