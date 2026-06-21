"""Tests for ``investment_dashboard.domain.returns``.

Golden-set checks reference Excel/LibreOffice ``XIRR`` for the same inputs;
the algorithm is independent (Newton-Raphson with bisection fallback) but
should converge to the same root to 4 decimal places.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from investment_dashboard.domain.returns import (
    Cashflow,
    DailyValuation,
    annualize_return,
    cagr,
    capital_gain,
    total_growth_pct,
    total_growth_pct_compounded,
    twr,
    xirr,
    years_between,
)


def _approx(actual: Decimal | None, expected: float, tol: float = 1e-4) -> bool:
    if actual is None:
        return False
    return abs(float(actual) - expected) < tol


class TestXirrBasic:
    def test_simple_lump_sum_one_year_10pct(self) -> None:
        # Invest 100 on 2023-01-01, worth 110 on 2024-01-01 ⇒ ~10% XIRR.
        cfs = [Cashflow(date(2023, 1, 1), Decimal(-100))]
        result = xirr(cfs, as_of=date(2024, 1, 1), terminal_value=Decimal(110))
        assert _approx(result, 0.10)

    def test_simple_lump_sum_one_year_loss(self) -> None:
        cfs = [Cashflow(date(2023, 1, 1), Decimal(-100))]
        result = xirr(cfs, as_of=date(2024, 1, 1), terminal_value=Decimal(90))
        assert _approx(result, -0.10)

    def test_two_year_doubling(self) -> None:
        # 100 → 200 over 2 years ⇒ sqrt(2) − 1 ≈ 0.4142
        cfs = [Cashflow(date(2022, 1, 1), Decimal(-100))]
        result = xirr(cfs, as_of=date(2024, 1, 1), terminal_value=Decimal(200))
        assert result is not None
        assert _approx(result, 0.41421356, tol=1e-3)

    def test_irregular_cashflows_npv_zero(self) -> None:
        # Self-verifying: whatever XIRR finds, NPV at that rate must be ~0.
        from investment_dashboard.domain.returns import _npv

        cfs = [
            Cashflow(date(2022, 1, 15), Decimal(-10000)),
            Cashflow(date(2022, 7, 1), Decimal(-5000)),
            Cashflow(date(2023, 3, 15), Decimal(2000)),
        ]
        terminal = Decimal(15000)
        result = xirr(cfs, as_of=date(2024, 1, 15), terminal_value=terminal)
        assert result is not None
        flows = [*cfs, Cashflow(date(2024, 1, 15), terminal)]
        residual = _npv(float(result), flows, date(2024, 1, 15))
        assert abs(residual) < 1e-3
        # Sanity: with a small net gain over ~2 years, rate should be modest.
        assert 0.0 < float(result) < 0.30

    def test_degenerate_all_negative_returns_none(self) -> None:
        cfs = [
            Cashflow(date(2023, 1, 1), Decimal(-100)),
            Cashflow(date(2023, 6, 1), Decimal(-50)),
        ]
        assert xirr(cfs, as_of=date(2024, 1, 1)) is None

    def test_empty_returns_none(self) -> None:
        assert xirr([], as_of=date(2024, 1, 1)) is None
        assert xirr([Cashflow(date(2024, 1, 1), Decimal(1))], as_of=date(2024, 1, 1)) is None

    def test_all_cashflows_on_one_date_returns_none(self) -> None:
        # Contribution and terminal both land on ``as_of``: NPV is
        # rate-independent (zero time span), so there is no unique IRR. The
        # solver must report ``None`` rather than the seed guess (0.10).
        cfs = [Cashflow(date(2024, 1, 1), Decimal(-100))]
        assert xirr(cfs, as_of=date(2024, 1, 1), terminal_value=Decimal(100)) is None

    def test_all_cashflows_on_same_non_as_of_date_returns_none(self) -> None:
        # Same single trade date, sign change present, but a zero span ⇒ None.
        cfs = [
            Cashflow(date(2023, 5, 1), Decimal(-100)),
            Cashflow(date(2023, 5, 1), Decimal(120)),
        ]
        assert xirr(cfs, as_of=date(2024, 1, 1)) is None


class TestTwr:
    def test_no_cashflows_just_growth(self) -> None:
        # 100 → 110 over 2 days, no cashflows ⇒ 10%.
        vals = [
            DailyValuation(date(2024, 1, 1), Decimal(100)),
            DailyValuation(date(2024, 1, 2), Decimal(110)),
        ]
        assert _approx(twr(vals, []), 0.10)

    def test_cashflow_does_not_inflate_return(self) -> None:
        # Start at 100, deposit 50 on day 2, value goes to 150 → 165.
        # Sub-period 1: (100−0)/100=1.00× (no growth pre-deposit)
        # Day 2: V_start_after_cf = 100 + 50 = 150, V_end = 150 ⇒ 0%.
        # Day 3: V_start_after_cf = 150, V_end = 165 ⇒ 10%.
        # Chained: 1.00 * 1.10 − 1 = 0.10.
        vals = [
            DailyValuation(date(2024, 1, 1), Decimal(100)),
            DailyValuation(date(2024, 1, 2), Decimal(150)),
            DailyValuation(date(2024, 1, 3), Decimal(165)),
        ]
        cfs = [Cashflow(date(2024, 1, 2), Decimal(-50))]  # deposit (cash in = negative)
        assert _approx(twr(vals, cfs), 0.10)

    def test_short_input_returns_none(self) -> None:
        assert twr([DailyValuation(date(2024, 1, 1), Decimal(100))], []) is None


class TestAnnualize:
    def test_annualize_half_year_doubling(self) -> None:
        # 100% return over half a year annualises to 300% (compound).
        # (1+1)^(365/182.5) − 1 = (1+1)^2 − 1 = 3.
        result = annualize_return(Decimal(1), 183)  # ~half-year
        assert result is not None
        # Allow a wide tolerance due to integer-day approximation.
        assert _approx(result, 2.97, tol=0.05)

    def test_zero_days_returns_none(self) -> None:
        assert annualize_return(Decimal("0.10"), 0) is None


class TestCagr:
    def test_3yr_doubling(self) -> None:
        result = cagr(Decimal(100), Decimal(200), days=1096)  # ~3 years
        assert result is not None
        # 2^(1/3) − 1 ≈ 0.2599
        assert _approx(result, 0.2599, tol=1e-3)

    def test_invalid_inputs(self) -> None:
        assert cagr(Decimal(0), Decimal(100), 365) is None
        assert cagr(Decimal(100), Decimal(-1), 365) is None
        assert cagr(Decimal(100), Decimal(200), 0) is None

    def test_total_loss_is_minus_100_percent(self) -> None:
        # A wipeout is a well-defined −100 % CAGR, not ``None``.
        assert cagr(Decimal(10_000), Decimal(0), 365) == Decimal(-1)


class TestGrowthPct:
    def test_total_growth(self) -> None:
        result = total_growth_pct(Decimal(1000), Decimal(1234))
        assert result == Decimal("0.234")

    def test_zero_contribution(self) -> None:
        assert total_growth_pct(Decimal(0), Decimal(100)) is None


class TestCapitalGain:
    def test_with_cash_dividends(self) -> None:
        result = capital_gain(
            contributions=Decimal(1000),
            current_value=Decimal(1100),
            cumulative_dividends_cash=Decimal(50),
        )
        assert result == Decimal(150)

    def test_no_dividends_default(self) -> None:
        assert capital_gain(Decimal(1000), Decimal(900)) == Decimal(-100)


@pytest.mark.parametrize(
    ("days", "expected_low", "expected_high"),
    [(365, 0.099, 0.101), (730, 0.099, 0.101)],
)
def test_xirr_is_annualised(days: int, expected_low: float, expected_high: float) -> None:
    """XIRR should be ~constant for the same effective annual rate."""
    # Same 10% annual rate over different windows.
    if days == 365:
        cfs = [Cashflow(date(2023, 1, 1), Decimal(-100))]
        result = xirr(cfs, as_of=date(2024, 1, 1), terminal_value=Decimal(110))
    else:
        cfs = [Cashflow(date(2022, 1, 1), Decimal(-100))]
        result = xirr(cfs, as_of=date(2024, 1, 1), terminal_value=Decimal(121))
    assert result is not None
    assert expected_low < float(result) < expected_high


# -----------------------------------------------------------------------------
# total_growth_pct_compounded / years_between (v2.5 headline metric)
# -----------------------------------------------------------------------------


class TestYearsBetween:
    def test_one_calendar_year(self) -> None:
        # 365 / 365.25 ≈ 0.99932
        y = years_between(date(2023, 1, 1), date(2024, 1, 1))
        assert _approx(y, 365.0 / 365.25)

    def test_negative_or_zero_returns_zero(self) -> None:
        assert years_between(date(2024, 1, 1), date(2024, 1, 1)) == Decimal(0)
        assert years_between(date(2024, 6, 1), date(2024, 1, 1)) == Decimal(0)

    def test_one_day(self) -> None:
        y = years_between(date(2024, 1, 1), date(2024, 1, 2))
        assert _approx(y, 1.0 / 365.25)


class TestTotalGrowthPctCompounded:
    def test_one_year_at_10pct(self) -> None:
        # XIRR 10% over 1 year ⇒ ~10% total growth.
        result = total_growth_pct_compounded(Decimal("0.10"), Decimal(1))
        assert _approx(result, 0.10)

    def test_ten_years_at_10pct(self) -> None:
        # XIRR 10% over 10 years ⇒ (1.1)^10 - 1 ≈ 1.5937
        result = total_growth_pct_compounded(Decimal("0.10"), Decimal(10))
        assert _approx(result, 1.59374246)

    def test_one_day_horizon(self) -> None:
        # XIRR 10% prorated to ~1 day.
        years = years_between(date(2024, 1, 1), date(2024, 1, 2))
        result = total_growth_pct_compounded(Decimal("0.10"), years)
        # (1.1)^(1/365.25) - 1 ≈ 0.0002610
        assert _approx(result, 0.0002610, tol=1e-5)

    def test_negative_xirr(self) -> None:
        # XIRR -20% over 2 years ⇒ (0.8)^2 - 1 = -0.36
        result = total_growth_pct_compounded(Decimal("-0.20"), Decimal(2))
        assert _approx(result, -0.36)

    def test_none_xirr(self) -> None:
        assert total_growth_pct_compounded(None, Decimal(1)) is None

    def test_zero_years(self) -> None:
        assert total_growth_pct_compounded(Decimal("0.10"), Decimal(0)) is None

    def test_negative_years(self) -> None:
        assert total_growth_pct_compounded(Decimal("0.10"), Decimal(-1)) is None

    def test_below_minus_one_xirr_returns_none(self) -> None:
        # Implies total wipe-out + more — not real-valued.
        assert total_growth_pct_compounded(Decimal("-1.5"), Decimal(2)) is None
