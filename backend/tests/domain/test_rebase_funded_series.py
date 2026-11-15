from decimal import Decimal

import pytest

from investment_dashboard.domain.returns import rebase_funded_series

D = Decimal


def test_rebased_benchmark_starts_at_portfolio_value() -> None:
    # Raw funded benchmark already carries pre-window gains (1000 on day 0).
    raw = [D(1000), D(1100), D(1210), D(1331)]
    nm = [D(0)] * 4
    out = rebase_funded_series(D(500), raw, nm)
    assert out[0] == D(500)
    # Same +10 % daily price return applied to the common base.
    assert out == [D(500), D(550), D(605), D("665.5")]


def test_flows_are_not_returns() -> None:
    # Day 1: deposit 100 buys at the day's price (+10 %): raw 1000 -> 1000*1.1+100.
    raw = [D(1000), D(1200)]
    nm = [D(0), D(100)]
    out = rebase_funded_series(D(200), raw, nm)
    assert out == [D(200), D(200) * D(1100) / D(1000) + D(100)]


def test_missing_raw_carries_forward() -> None:
    out = rebase_funded_series(D(10), [None, D(5), D(6)], [D(0), D(0), D(0)])
    assert out[0] == D(10)
    assert out[1] == D(10)
    assert out[2] == D(12)


def test_length_mismatch() -> None:
    with pytest.raises(ValueError, match="same length"):
        rebase_funded_series(D(1), [D(1)], [])
