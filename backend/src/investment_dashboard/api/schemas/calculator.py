"""Schemas for ``/api/calculator`` (inputs/defaults and the projection what-if)."""

from __future__ import annotations

from decimal import Decimal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, Ccy, DecStr


class SeedOut(ApiModel):
    monthly: bool
    ccy: Ccy
    starting_value: DecStr | None
    avg_contribution: DecStr | None
    expected_rate: DecStr | None
    xirr_available: bool
    usd_per_eur: DecStr | None
    as_of: str


class CalcInstrumentOut(ApiModel):
    instrument_id: int
    symbol: str
    name: str
    category: str
    current_value: DecStr | None
    current_pct: DecStr | None = Field(description="Share of total value, PERCENT 0-100")


class CalcCategoryOut(ApiModel):
    name: str
    current_value: DecStr | None
    current_pct: DecStr | None = Field(description="Share of total value, PERCENT 0-100")
    members: list[int]


class ProjectionDefaultsOut(ApiModel):
    month: SeedOut
    year: SeedOut


class CalculatorInputsOut(ApiModel):
    ccy: Ccy
    as_of: str
    fx_usd_per_eur: DecStr | None
    total_value: DecStr | None
    instruments: list[CalcInstrumentOut]
    categories: list[CalcCategoryOut]
    projection_defaults: ProjectionDefaultsOut


class ProjectionRequest(ApiModel):
    """What-if assumptions. Percent inputs are percent (``7`` = 7 %); ``None`` = use the default."""

    monthly: bool = False
    expected_return_pct: Decimal | None = Field(default=None, ge=-99, le=100)
    band_pp: Decimal = Field(default=Decimal(3), ge=0, le=100)
    step_up_pct: Decimal = Field(default=Decimal(0), ge=0, le=100)
    inflation_pct: Decimal = Field(default=Decimal(2), ge=-50, le=100)
    contribution: Decimal | None = Field(default=None, ge=0)
    target: Decimal = Field(default=Decimal(0), ge=0)
    horizon: int | None = Field(default=None, ge=0, le=600)
    real: bool = False


class ProjectionPointOut(ApiModel):
    label: str
    years: DecStr | None
    contributed: DecStr | None
    pessimistic: DecStr | None
    expected: DecStr | None
    optimistic: DecStr | None
    pessimistic_real: DecStr | None
    expected_real: DecStr | None
    optimistic_real: DecStr | None


class ProjectionFinalOut(ApiModel):
    pessimistic: DecStr | None
    expected: DecStr | None
    optimistic: DecStr | None
    projected_growth: DecStr | None


class TargetHitOut(ApiModel):
    label: str
    years: DecStr | None


class ProjectionInputsOut(ApiModel):
    expected_rate: DecStr | None
    band: DecStr | None
    stepup: DecStr | None
    inflation: DecStr | None
    horizon: int
    contribution: DecStr | None
    target: DecStr | None


class ProjectionAssumptionsOut(ApiModel):
    """Forward assumptions; ``usd_per_eur`` is the only cross-currency rate used."""

    usd_per_eur: DecStr | None
    expected_rate_default: DecStr | None
    xirr_available: bool


class ProjectionOut(ApiModel):
    ccy: Ccy
    monthly: bool
    real: bool
    as_of: str
    starting_value: DecStr | None
    total_contributed: DecStr | None
    final: ProjectionFinalOut
    points: list[ProjectionPointOut]
    hits: dict[str, TargetHitOut | None]
    required_contribution: DecStr | None
    inputs: ProjectionInputsOut
    assumptions: ProjectionAssumptionsOut
