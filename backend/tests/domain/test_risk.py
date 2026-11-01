"""Tests for ``investment_dashboard.domain.risk``."""

from __future__ import annotations

import math
from decimal import Decimal

import pytest

from investment_dashboard.domain.risk import (
    alpha,
    annualized_volatility,
    best_worst_month,
    beta,
    max_drawdown,
    monthly_win_rate,
    sharpe_ratio,
    sortino_ratio,
)


def _approx(actual: Decimal | None, expected: float, tol: float = 1e-3) -> bool:
    if actual is None:
        return False
    return abs(float(actual) - expected) < tol


def _ret(values: list[float]) -> list[Decimal]:
    return [Decimal(repr(v)) for v in values]


class TestVolatility:
    def test_constant_returns_zero_vol(self) -> None:
        result = annualized_volatility(_ret([0.001, 0.001, 0.001, 0.001]))
        assert result == Decimal("0")

    def test_known_stdev(self) -> None:
        # Daily returns [+1%, -1%, +1%, -1%]: sample stdev = 0.01154… × √252.
        result = annualized_volatility(_ret([0.01, -0.01, 0.01, -0.01]))
        assert result is not None
        # Sample stdev = sqrt(sum((x-0)^2)/(n-1)) = sqrt(4*1e-4/3) ≈ 0.01155
        expected = math.sqrt(4 * 0.0001 / 3) * math.sqrt(252)
        assert _approx(result, expected, tol=1e-6)

    def test_too_few_points(self) -> None:
        assert annualized_volatility([]) is None
        assert annualized_volatility(_ret([0.01])) is None


class TestSharpe:
    def test_zero_rf_positive_mean(self) -> None:
        # daily 1% with vol 0 → None (no risk).
        assert sharpe_ratio(_ret([0.01, 0.01, 0.01]), Decimal(0)) is None

    def test_negative_excess_return_yields_negative_sharpe(self) -> None:
        # Tiny positive mean, rf = 10% ⇒ excess return < 0.
        result = sharpe_ratio(_ret([0.001, -0.001, 0.001, -0.001]), Decimal("0.10"))
        assert result is not None
        assert result < 0


class TestSortino:
    def test_only_positive_returns_no_downside(self) -> None:
        # All returns above the daily target ⇒ downside dev = 0 ⇒ None.
        result = sortino_ratio(_ret([0.01, 0.02, 0.015]), Decimal(0))
        assert result is None

    def test_with_downside(self) -> None:
        result = sortino_ratio(_ret([0.01, -0.02, 0.005, -0.01]), Decimal(0))
        assert result is not None


class TestDrawdown:
    def test_monotonic_increase_zero_drawdown(self) -> None:
        assert max_drawdown(_ret([1.0, 1.1, 1.2, 1.3])) == Decimal(0)

    def test_50pct_drawdown(self) -> None:
        # 100 → 200 → 100 ⇒ 50% drawdown from peak.
        result = max_drawdown(_ret([100.0, 200.0, 100.0]))
        assert _approx(result, -0.50, tol=1e-9)

    def test_recovery_does_not_undo_drawdown(self) -> None:
        # 100 → 50 → 150: max drawdown was -50%, even though final > start.
        result = max_drawdown(_ret([100.0, 50.0, 150.0]))
        assert _approx(result, -0.50, tol=1e-9)

    def test_short_input_returns_zero(self) -> None:
        assert max_drawdown([]) == Decimal(0)
        assert max_drawdown(_ret([100.0])) == Decimal(0)


class TestMonthly:
    def test_best_worst_month(self) -> None:
        result = best_worst_month(_ret([0.05, -0.03, 0.01, 0.02]))
        assert result == (Decimal("0.05"), Decimal("-0.03"))

    def test_win_rate(self) -> None:
        result = monthly_win_rate(_ret([0.01, -0.01, 0.02, 0.0, -0.02]))
        # 2 wins / 5 months (zero is not a "win").
        assert result == Decimal("0.4")

    def test_empty_returns_none(self) -> None:
        assert best_worst_month([]) is None
        assert monthly_win_rate([]) is None


class TestBetaAlpha:
    def test_identical_series_beta_one(self) -> None:
        rs = _ret([0.01, -0.005, 0.02, -0.01, 0.003])
        result = beta(rs, rs)
        assert _approx(result, 1.0, tol=1e-9)

    def test_doubled_series_beta_two(self) -> None:
        rs = _ret([0.01, -0.005, 0.02, -0.01, 0.003])
        rs_2 = _ret([0.02, -0.010, 0.04, -0.02, 0.006])
        result = beta(rs_2, rs)
        assert _approx(result, 2.0, tol=1e-9)

    def test_mismatched_lengths_returns_none(self) -> None:
        assert beta(_ret([0.01, 0.02]), _ret([0.01])) is None

    def test_zero_variance_benchmark(self) -> None:
        # Constant benchmark ⇒ var = 0 ⇒ None.
        assert beta(_ret([0.01, -0.01]), _ret([0.005, 0.005])) is None

    def test_alpha_identical_zero(self) -> None:
        rs = _ret([0.01, -0.005, 0.02, -0.01, 0.003])
        # Alpha vs self should be exactly 0 (β=1, R_p=R_b).
        result = alpha(rs, rs, Decimal("0.035"))
        assert _approx(result, 0.0, tol=1e-9)


@pytest.mark.parametrize(
    "n",
    [2, 3, 5, 10, 30],
)
def test_vol_stable_across_lengths(n: int) -> None:
    """Volatility on a constant series is exactly zero regardless of length."""
    result = annualized_volatility(_ret([0.005] * n))
    assert result == Decimal(0)
