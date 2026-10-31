"""Tests for the interactive projection engine (v2.3)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from investment_dashboard.ui.pages._projection_model import (
    FALLBACK_EXPECTED_RATE,
    SCENARIO_EXPECTED,
    SCENARIO_OPTIMISTIC,
    SCENARIO_PESSIMISTIC,
    ProjectionParams,
    band_rates,
    default_expected_rate,
    required_contribution,
    sanitize_rate,
    simulate,
    time_to_target,
)


def _params(**kw):  # type: ignore[no-untyped-def]
    base = {
        "starting_value": Decimal("1000"),
        "base_contribution": Decimal("100"),
        "periods": 12,
        "periods_per_year": 1,
        "annual_rates": band_rates(Decimal("0.07"), Decimal("0.03")),
        "start": date(2025, 1, 1),
    }
    base.update(kw)
    return ProjectionParams(**base)  # type: ignore[arg-type]


def test_default_expected_rate_uses_xirr_when_present() -> None:
    assert default_expected_rate(Decimal("0.085")) == Decimal("0.085")


def test_default_expected_rate_falls_back_when_none() -> None:
    assert default_expected_rate(None) == FALLBACK_EXPECTED_RATE


def test_sanitize_rate_clamps_extremes() -> None:
    assert sanitize_rate(Decimal("9.0")) == Decimal("0.40")
    assert sanitize_rate(Decimal("-2.0")) == Decimal("-0.50")


def test_band_rates_fan_out_symmetrically() -> None:
    rates = band_rates(Decimal("0.07"), Decimal("0.03"))
    assert rates[SCENARIO_PESSIMISTIC] == Decimal("0.04")
    assert rates[SCENARIO_EXPECTED] == Decimal("0.07")
    assert rates[SCENARIO_OPTIMISTIC] == Decimal("0.10")


def test_band_rates_floor_pessimistic() -> None:
    rates = band_rates(Decimal("0.05"), Decimal("2.0"))
    assert rates[SCENARIO_PESSIMISTIC] == Decimal("-0.99")


def test_simulate_zero_growth_yearly_just_sums() -> None:
    params = _params(annual_rates={SCENARIO_EXPECTED: Decimal("0")}, periods=3)
    result = simulate(params)
    finals = [p.nominal_by_scenario[SCENARIO_EXPECTED] for p in result.points]
    assert finals == [Decimal("1100"), Decimal("1200"), Decimal("1300")]
    assert [p.label for p in result.points] == ["2026", "2027", "2028"]
    assert result.total_contributed == Decimal("300")


def test_simulate_band_ordering_holds() -> None:
    result = simulate(_params())
    last = result.final
    assert last is not None
    assert (
        last.nominal_by_scenario[SCENARIO_PESSIMISTIC]
        < last.nominal_by_scenario[SCENARIO_EXPECTED]
        < last.nominal_by_scenario[SCENARIO_OPTIMISTIC]
    )


def test_simulate_monthly_compounds_at_monthly_rate() -> None:
    params = _params(
        starting_value=Decimal("1000"),
        base_contribution=Decimal("0"),
        periods=12,
        periods_per_year=12,
        annual_rates={SCENARIO_EXPECTED: Decimal("0.12")},
    )
    result = simulate(params)
    # 12 months of pure 12% annual compounding ≈ 1120.
    last = result.final.nominal_by_scenario[SCENARIO_EXPECTED]
    assert Decimal("1119") < last < Decimal("1121")
    assert result.points[0].label == "2025-02"


def test_contribution_step_up_increases_contributions() -> None:
    flat = simulate(
        _params(
            annual_contribution_growth=Decimal("0"),
            periods=3,
            annual_rates={SCENARIO_EXPECTED: Decimal("0")},
        )
    )
    grown = simulate(
        _params(
            annual_contribution_growth=Decimal("0.10"),
            periods=3,
            annual_rates={SCENARIO_EXPECTED: Decimal("0")},
        )
    )
    # Year 1 same (100), later years larger with step-up.
    assert grown.points[0].contributed == flat.points[0].contributed
    assert grown.points[-1].contributed > flat.points[-1].contributed


def test_inflation_real_value_below_nominal() -> None:
    result = simulate(_params(inflation_rate=Decimal("0.03")))
    last = result.final
    assert last is not None
    assert last.real_by_scenario[SCENARIO_EXPECTED] < last.nominal_by_scenario[SCENARIO_EXPECTED]


def test_zero_inflation_real_equals_nominal() -> None:
    result = simulate(_params(inflation_rate=Decimal("0")))
    last = result.final
    assert last.real_by_scenario[SCENARIO_EXPECTED] == last.nominal_by_scenario[SCENARIO_EXPECTED]


def test_simulate_rejects_negative_periods() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        simulate(_params(periods=-1))


def test_time_to_target_orders_scenarios() -> None:
    result = simulate(_params(periods=40))
    hits = time_to_target(result, Decimal("3000"))
    # Optimistic reaches the target no later than pessimistic.
    assert hits[SCENARIO_OPTIMISTIC] is not None
    assert hits[SCENARIO_PESSIMISTIC] is not None
    assert hits[SCENARIO_OPTIMISTIC].index <= hits[SCENARIO_PESSIMISTIC].index


def test_time_to_target_none_when_unreached() -> None:
    result = simulate(_params(periods=1))
    assert time_to_target(result, Decimal("10_000_000"))[SCENARIO_EXPECTED] is None


def test_required_contribution_hits_target() -> None:
    params = _params(periods=10, annual_rates=band_rates(Decimal("0.07"), Decimal("0.03")))
    target = Decimal("50000")
    needed = required_contribution(params, target)
    assert needed is not None
    # Plugging the solved contribution back in should reach (≈) the target.
    solved = simulate(
        ProjectionParams(
            starting_value=params.starting_value,
            base_contribution=needed,
            periods=params.periods,
            periods_per_year=params.periods_per_year,
            annual_rates={SCENARIO_EXPECTED: params.annual_rates[SCENARIO_EXPECTED]},
            start=params.start,
        )
    ).final_nominal(SCENARIO_EXPECTED)
    assert solved >= target * Decimal("0.999")


def test_required_contribution_zero_when_already_met() -> None:
    params = _params(starting_value=Decimal("100000"), periods=10)
    assert required_contribution(params, Decimal("1000")) == Decimal("0")
