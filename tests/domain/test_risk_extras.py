"""Tests for ``investment_dashboard.domain.risk_extras``."""

from __future__ import annotations

from decimal import Decimal

import pytest

from investment_dashboard.domain.risk_extras import (
    calmar_ratio,
    excess_kurtosis,
    historical_cvar,
    historical_var,
    skewness,
    ulcer_index,
)


def D(x: float) -> Decimal:
    return Decimal(repr(x))


def _approx(actual: Decimal | None, expected: float, tol: float = 1e-4) -> bool:
    if actual is None:
        return False
    return abs(float(actual) - expected) < tol


class TestCalmar:
    def test_zero_drawdown_returns_none(self) -> None:
        rets = [D(0.001)] * 10
        values = [D(100), D(101), D(102), D(103)]
        assert calmar_ratio(rets, values) is None

    def test_positive_return_negative_dd(self) -> None:
        # Mean daily return 0.001 ⇒ annualised 0.252; MDD from
        # 100 → 90 = -0.10. Calmar = 0.252 / 0.10 = 2.52.
        rets = [D(0.001)] * 50
        values = [D(100), D(95), D(90), D(95), D(100)]
        out = calmar_ratio(rets, values)
        assert _approx(out, 2.52, tol=0.05)


class TestUlcer:
    def test_monotone_up_is_zero(self) -> None:
        out = ulcer_index([D(100), D(101), D(102), D(103)])
        assert out is not None
        assert out == Decimal(0)

    def test_drawdown_then_recovery_is_positive(self) -> None:
        # 100 → 90 → 100 ⇒ avg dd² = ((0)² + (-0.10)² + 0²)/3 = 0.00333
        out = ulcer_index([D(100), D(90), D(100)])
        assert out is not None
        assert float(out) == pytest.approx(0.05773502, abs=1e-4)

    def test_too_few_points(self) -> None:
        assert ulcer_index([D(100)]) is None


class TestVarCvar:
    def test_var_5pct_on_uniform_returns(self) -> None:
        # 100 returns: -50%..+49% in 1%-steps. 5% VaR ≈ -46%.
        rets = [D(-0.50 + i * 0.01) for i in range(100)]
        out = historical_var(rets, Decimal("0.05"))
        assert _approx(out, -0.46, tol=1e-3)

    def test_cvar_is_average_of_left_tail(self) -> None:
        rets = [D(-0.10), D(-0.05), D(-0.02), D(0.01), D(0.03)] * 20  # 100
        var = historical_var(rets, Decimal("0.20"))  # tail = bottom 20
        cvar = historical_cvar(rets, Decimal("0.20"))
        assert var is not None
        assert cvar is not None
        assert cvar <= var

    def test_empty_returns_none(self) -> None:
        assert historical_var([], Decimal("0.05")) is None
        assert historical_cvar([], Decimal("0.05")) is None

    def test_invalid_alpha(self) -> None:
        with pytest.raises(ValueError, match="alpha"):
            historical_var([D(0.01)], Decimal(0))


class TestSkewKurtosis:
    def test_symmetric_returns_zero_skew(self) -> None:
        rets = [D(-0.02), D(-0.01), D(0.0), D(0.01), D(0.02)]
        s = skewness(rets)
        assert s is not None
        assert abs(float(s)) < 1e-6

    def test_left_skewed_negative(self) -> None:
        # Few large losses, many small gains.
        rets = [D(-0.10)] + [D(0.01)] * 19
        s = skewness(rets)
        assert s is not None
        assert float(s) < 0

    def test_excess_kurtosis_of_normal_ish(self) -> None:
        # Equally-spaced uniform-ish distribution → negative excess kurtosis.
        rets = [D(-0.05 + i * 0.01) for i in range(11)]
        k = excess_kurtosis(rets)
        assert k is not None
        assert float(k) < 0

    def test_too_few_points(self) -> None:
        assert skewness([D(0.01), D(0.02)]) is None
        assert excess_kurtosis([D(0.01), D(0.02), D(0.03)]) is None
