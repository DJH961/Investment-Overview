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
    asset_class: str = Field(
        default="", description='Effective asset class ("etf", "mutual_fund", ...)'
    )
    current_value: DecStr | None
    current_pct: DecStr | None = Field(description="Share of total value (fraction, 0.01 = 1%)")
    is_cash: bool = Field(
        default=False, description="Money-market fund or cash position (the Cash group)"
    )


class CalcCategoryOut(ApiModel):
    name: str
    current_value: DecStr | None
    current_pct: DecStr | None = Field(description="Share of total value (fraction, 0.01 = 1%)")
    members: list[int]
    is_cash: bool = False


class ProjectionDefaultsOut(ApiModel):
    month: SeedOut
    year: SeedOut


class CalculatorInputsOut(ApiModel):
    ccy: Ccy
    as_of: str
    fx_usd_per_eur: DecStr | None
    total_value: DecStr | None
    investable_cash: DecStr | None = Field(
        default=None,
        description="Cash held (money-market funds + cash positions) in `ccy` (native USD for USD)",
    )
    investable_cash_eur: DecStr | None = Field(
        default=None, description="Cash held in EUR (the EUR mark)"
    )
    investable_cash_usd: DecStr | None = Field(
        default=None, description="Cash held in native USD (never the EUR mark times a rate)"
    )
    instruments: list[CalcInstrumentOut]
    categories: list[CalcCategoryOut]
    projection_defaults: ProjectionDefaultsOut


class ProjectionRequest(ApiModel):
    """What-if assumptions. ``*_pct`` inputs are fractions (``0.07`` = 7 %); ``band_pp`` is percentage points
    (``3`` = 3 pp); ``None`` = use the default."""

    monthly: bool = False
    expected_return_pct: Decimal | None = Field(default=None, ge=-0.99, le=1)
    band_pp: Decimal = Field(default=Decimal(3), ge=0, le=100)
    step_up_pct: Decimal = Field(default=Decimal(0), ge=0, le=1)
    inflation_pct: Decimal = Field(default=Decimal("0.02"), ge=-0.5, le=1)
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
    #: P5 (v7.2): the euro result over a range of EUR/USD rates. EUR view only;
    #: null in the USD view or without a projected dollar wallet.
    rate_band: ProjectionRateBandOut | None = None


class ProjectionRateRowOut(ApiModel):
    """The projected dollar wallet's final value converted at one assumed rate."""

    #: Assumed EUR/USD rate at the horizon (USD per 1 EUR).
    usd_per_eur: DecStr
    #: ``usd_per_eur / today's rate - 1``.
    shift_pct: DecStr
    pessimistic: DecStr | None
    expected: DecStr | None
    optimistic: DecStr | None


class ProjectionRateBandOut(ApiModel):
    """P5: the dollar wallet, simulated at its own USD XIRR, valued in euros at each rate.

    A single-instant valuation at an *assumed* future rate (no return is converted):
    ``final_usd / usd_per_eur``. ``rows`` run from today's rate - 15 % to + 15 %;
    ``low``/``high`` are the EUR values at the ends for the expected scenario.
    """

    ccy: Ccy = "EUR"
    #: Today's EUR/USD rate (the projection's ``assumptions.usd_per_eur``).
    usd_per_eur_now: DecStr
    #: The dollar wallet's projected final values, native USD.
    final_usd: ProjectionFinalOut
    rows: list[ProjectionRateRowOut] = Field(default_factory=list)
    expected_low: DecStr | None = None
    expected_high: DecStr | None = None
