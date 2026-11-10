"""``growth_index``: the flow-adjusted series every Risk figure is computed on."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.returns import Cashflow, DailyValuation, growth_index, twr

D = Decimal


def test_golden_deposit_is_not_a_gain() -> None:
    # Day 0: 1000. Day 1: +1% -> 1010. Day 2: deposit 1000 and flat -> 2010.
    # Day 3: -10% -> 1809. Hand-checked: 1 -> 1.01 -> 1.01 -> 0.909.
    values = [D(1000), D(1010), D(2010), D(1809)]
    new_money = [D(0), D(0), D(1000), D(0)]
    assert growth_index(values, new_money) == [D(1), D("1.01"), D("1.01"), D("0.909")]


def test_golden_withdrawal_is_not_a_loss() -> None:
    values = [D(2000), D(1000)]  # withdrew 1000, market flat
    assert growth_index(values, [D(0), D(-1000)]) == [D(1), D(1)]


def test_nothing_invested_yet_carries_the_index() -> None:
    values = [D(0), D(0), D(500), D(550)]  # first deposit on day 2
    new_money = [D(0), D(0), D(500), D(0)]
    assert growth_index(values, new_money) == [D(1), D(1), D(1), D("1.1")]


def test_lengths_must_match() -> None:
    with pytest.raises(ValueError, match="same length"):
        growth_index([D(1)], [])
    assert growth_index([], []) == []


money = st.decimals(min_value=D(1), max_value=D(1_000_000), places=2)
flow = st.decimals(min_value=D(0), max_value=D(50_000), places=2)


@given(st.lists(st.tuples(money, flow), min_size=2, max_size=40))
def test_index_end_equals_twr(days: list[tuple[Decimal, Decimal]]) -> None:
    """index[-1] - 1 is exactly the TWR over the same valuations and flows."""
    values = [v for v, _ in days]
    new_money = [D(0)] + [f for _, f in days[1:]]
    start = date(2024, 1, 1)
    vals = [DailyValuation(start + timedelta(days=i), v) for i, v in enumerate(values)]
    flows = [Cashflow(start + timedelta(days=i), -f) for i, f in enumerate(new_money) if f]
    expected = twr(vals, flows)
    assert expected is not None
    assert abs((growth_index(values, new_money)[-1] - 1) - expected) < D("1e-18")


@given(st.lists(money, min_size=1, max_size=40))
def test_without_flows_the_index_is_value_over_first_value(values: list[Decimal]) -> None:
    index = growth_index(values, [D(0)] * len(values))
    for i, v in zip(index, values, strict=True):
        assert abs(i - v / values[0]) < D("1e-18")


@given(st.lists(money, min_size=2, max_size=20), money, st.integers(min_value=1, max_value=19))
def test_adding_money_never_changes_the_index(
    values: list[Decimal], extra: Decimal, day: int
) -> None:
    """A deposit invested at the market's rate leaves the index exactly where it was.

    ``extra`` comes in at the start of ``day`` (TWR convention) and from then on grows
    with the portfolio, so every later value is scaled by ``(1 + extra / V_{day-1})``.
    """
    day = min(day, len(values) - 1)
    base = growth_index(values, [D(0)] * len(values))
    scale = D(1) + extra / values[day - 1]
    bumped = [v if i < day else v * scale for i, v in enumerate(values)]
    new_money = [extra if i == day else D(0) for i in range(len(values))]
    for a, b in zip(growth_index(bumped, new_money), base, strict=True):
        assert abs(a - b) < D("1e-18")
