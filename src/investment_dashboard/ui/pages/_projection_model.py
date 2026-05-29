"""Interactive portfolio projection engine (v2.3).

This is the pure-math core behind the *Projection* tool on ``/monthly``
and ``/yearly``. It replaces the old fixed three-rate table with a single,
realistic, **XIRR-anchored** forward simulation:

* The **expected** scenario compounds at the portfolio's own historical
  money-weighted return (XIRR) — "assuming existing performance
  continues". Callers supply that rate; :func:`default_expected_rate`
  sanitises it.
* **Optimistic** / **pessimistic** scenarios fan out symmetrically around
  the expected rate by a user-controlled ``band`` (in annual percentage
  points), giving an intuitive cone of outcomes.
* Contributions can **step up** over time (an annual raise %), because the
  user expects to invest more in future.
* Every nominal figure also gets an **inflation-adjusted (real)** twin so
  "future euros" are comparable to today's.
* Goal seeking answers the two questions a planner actually has: *when do
  I hit my target?* (:func:`time_to_target`) and *what would I have to
  contribute to hit it by the horizon?* (:func:`required_contribution`).

Everything here is pure (no DB, no NiceGUI) so it is cheap to unit-test;
the thin session/seed loader lives in :func:`build_seed`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

ZERO = Decimal(0)
ONE = Decimal(1)

# Fallback expected return when a portfolio has no usable XIRR yet (too
# young, all-same-sign cashflows, solver did not converge). 7 % nominal is
# a conventional long-run broad-equity planning assumption.
FALLBACK_EXPECTED_RATE = Decimal("0.07")
# Guard rails so a wild XIRR from a brand-new portfolio (e.g. +900 % from a
# single lucky week) does not produce an absurd multi-decade projection.
_MIN_REASONABLE_RATE = Decimal("-0.50")
_MAX_REASONABLE_RATE = Decimal("0.40")

SCENARIO_EXPECTED = "expected"
SCENARIO_OPTIMISTIC = "optimistic"
SCENARIO_PESSIMISTIC = "pessimistic"
SCENARIO_NAMES: tuple[str, str, str] = (
    SCENARIO_PESSIMISTIC,
    SCENARIO_EXPECTED,
    SCENARIO_OPTIMISTIC,
)


@dataclass(frozen=True)
class ProjectionParams:
    """All assumptions for one simulation run (currency-agnostic, EUR base).

    ``periods_per_year`` is 12 for the monthly view and 1 for the yearly
    view. ``annual_rates`` maps each scenario name to an **annual** growth
    rate; we compound at its per-period equivalent.
    """

    starting_value: Decimal
    base_contribution: Decimal
    periods: int
    periods_per_year: int
    annual_rates: dict[str, Decimal]
    annual_contribution_growth: Decimal = ZERO
    inflation_rate: Decimal = ZERO
    start: date | None = None


@dataclass(frozen=True)
class ProjectionPoint:
    """One simulated period."""

    index: int  # 1-based period offset from "today"
    label: str  # "YYYY-MM" (monthly) or "YYYY" (yearly)
    period_date: date
    contributed: Decimal  # cumulative new money up to and including this period
    nominal_by_scenario: dict[str, Decimal]
    real_by_scenario: dict[str, Decimal]  # inflation-adjusted to today's euros


@dataclass(frozen=True)
class TargetHit:
    """When a scenario first reaches a target value."""

    scenario: str
    label: str
    index: int
    years: Decimal


@dataclass(frozen=True)
class ProjectionResult:
    """Full simulation output plus convenience summaries."""

    params: ProjectionParams
    points: list[ProjectionPoint] = field(default_factory=list)

    @property
    def final(self) -> ProjectionPoint | None:
        return self.points[-1] if self.points else None

    def final_nominal(self, scenario: str) -> Decimal:
        last = self.final
        if last is None:
            return self.params.starting_value
        return last.nominal_by_scenario[scenario]

    @property
    def total_contributed(self) -> Decimal:
        last = self.final
        return last.contributed if last is not None else ZERO


def _per_period_rate(annual_rate: Decimal, periods_per_year: int) -> Decimal:
    """Per-period equivalent of ``annual_rate`` (geometric, not naive /n)."""
    if periods_per_year <= 1:
        return annual_rate
    base = ONE + annual_rate
    if base <= 0:
        return Decimal("-1")
    return Decimal(repr(float(base) ** (1.0 / periods_per_year))) - ONE


def _advance_label(start: date, index: int, periods_per_year: int) -> tuple[str, date]:
    """Label + representative date for the ``index``-th period after ``start``."""
    if periods_per_year >= 12:
        total = (start.year * 12 + (start.month - 1)) + index
        year, month0 = divmod(total, 12)
        month = month0 + 1
        return f"{year:04d}-{month:02d}", date(year, month, 1)
    year = start.year + index
    return f"{year:04d}", date(year, 12, 31)


def sanitize_rate(rate: Decimal | None) -> Decimal:
    """Clamp an arbitrary (possibly ``None``/extreme) rate into a sane band."""
    if rate is None:
        return FALLBACK_EXPECTED_RATE
    if rate < _MIN_REASONABLE_RATE:
        return _MIN_REASONABLE_RATE
    if rate > _MAX_REASONABLE_RATE:
        return _MAX_REASONABLE_RATE
    return rate


def default_expected_rate(xirr: Decimal | None) -> Decimal:
    """Pick the default expected return: the portfolio's XIRR, sanitised."""
    if xirr is None:
        return FALLBACK_EXPECTED_RATE
    return sanitize_rate(xirr)


def band_rates(expected: Decimal, band: Decimal) -> dict[str, Decimal]:
    """Expected ± ``band`` annual percentage points (pessimistic floored)."""
    pessimistic = expected - band
    pessimistic = max(Decimal("-0.99"), pessimistic)
    return {
        SCENARIO_PESSIMISTIC: pessimistic,
        SCENARIO_EXPECTED: expected,
        SCENARIO_OPTIMISTIC: expected + band,
    }


def _contribution_for_period(
    base: Decimal,
    *,
    index: int,
    periods_per_year: int,
    annual_growth: Decimal,
) -> Decimal:
    """Contribution in period ``index`` after applying the annual step-up."""
    if annual_growth == ZERO:
        return base
    year_index = (index - 1) // periods_per_year
    return base * (ONE + annual_growth) ** year_index


def simulate(params: ProjectionParams) -> ProjectionResult:
    """Run the forward simulation described by ``params``.

    Each period the balance grows by the scenario's per-period rate and
    then receives that period's (possibly stepped-up) contribution at
    period end — an ordinary annuity, matching the rest of the app.

    Raises ``ValueError`` for negative horizons or invalid period counts.
    """
    if params.periods < 0:
        raise ValueError("periods must be non-negative")
    if params.periods_per_year < 1:
        raise ValueError("periods_per_year must be >= 1")

    start = params.start or date.today()
    per_period = {
        name: _per_period_rate(rate, params.periods_per_year)
        for name, rate in params.annual_rates.items()
    }
    values = {name: params.starting_value for name in params.annual_rates}
    cumulative = ZERO
    points: list[ProjectionPoint] = []

    for index in range(1, params.periods + 1):
        contrib = _contribution_for_period(
            params.base_contribution,
            index=index,
            periods_per_year=params.periods_per_year,
            annual_growth=params.annual_contribution_growth,
        )
        cumulative += contrib
        for name in params.annual_rates:
            values[name] = values[name] * (ONE + per_period[name]) + contrib

        years_elapsed = Decimal(index) / Decimal(params.periods_per_year)
        deflator = (ONE + params.inflation_rate) ** years_elapsed
        label, period_date = _advance_label(start, index, params.periods_per_year)
        nominal = dict(values)
        real = (
            {name: v / deflator for name, v in nominal.items()} if deflator != 0 else dict(nominal)
        )
        points.append(
            ProjectionPoint(
                index=index,
                label=label,
                period_date=period_date,
                contributed=cumulative,
                nominal_by_scenario=nominal,
                real_by_scenario=real,
            )
        )

    return ProjectionResult(params=params, points=points)


def time_to_target(
    result: ProjectionResult,
    target: Decimal,
    *,
    scenarios: tuple[str, ...] = SCENARIO_NAMES,
    real: bool = False,
) -> dict[str, TargetHit | None]:
    """First period in which each scenario reaches ``target`` (or ``None``).

    When ``real`` is true the comparison uses inflation-adjusted values, so
    the target is expressed in today's purchasing power.
    """
    out: dict[str, TargetHit | None] = {s: None for s in scenarios}
    if target <= 0:
        return out
    for point in result.points:
        series = point.real_by_scenario if real else point.nominal_by_scenario
        for scenario in scenarios:
            if out[scenario] is None and series.get(scenario, ZERO) >= target:
                out[scenario] = TargetHit(
                    scenario=scenario,
                    label=point.label,
                    index=point.index,
                    years=Decimal(point.index) / Decimal(result.params.periods_per_year),
                )
    return out


def _final_value_for_contribution(
    params: ProjectionParams, base: Decimal, scenario: str
) -> Decimal:
    """Final expected value if the per-period base contribution were ``base``."""
    trial = ProjectionParams(
        starting_value=params.starting_value,
        base_contribution=base,
        periods=params.periods,
        periods_per_year=params.periods_per_year,
        annual_rates={scenario: params.annual_rates[scenario]},
        annual_contribution_growth=params.annual_contribution_growth,
        inflation_rate=params.inflation_rate,
        start=params.start,
    )
    return simulate(trial).final_nominal(scenario)


def required_contribution(
    params: ProjectionParams,
    target: Decimal,
    *,
    scenario: str = SCENARIO_EXPECTED,
    max_iter: int = 60,
) -> Decimal | None:
    """Per-period contribution needed to reach ``target`` by the horizon.

    Solved by bisection on the (monotonic-in-contribution) final value.
    Returns ``ZERO`` when the target is already met with no new money, and
    ``None`` when even a very large contribution cannot reach it within the
    horizon (e.g. horizon of zero periods).
    """
    if params.periods <= 0 or target <= 0:
        return None
    if _final_value_for_contribution(params, ZERO, scenario) >= target:
        return ZERO

    lo, hi = ZERO, max(target, Decimal("1"))
    # Expand the upper bound until it overshoots the target.
    for _ in range(40):
        if _final_value_for_contribution(params, hi, scenario) >= target:
            break
        hi *= 2
    else:
        return None

    for _ in range(max_iter):
        mid = (lo + hi) / 2
        if _final_value_for_contribution(params, mid, scenario) >= target:
            hi = mid
        else:
            lo = mid
    return hi
