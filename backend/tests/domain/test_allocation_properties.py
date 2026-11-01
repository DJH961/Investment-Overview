"""Property + golden tests for ``domain.allocation``."""

from __future__ import annotations

from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.allocation import current_weights_pct, plan_rebalance

_money = st.decimals(min_value=Decimal(0), max_value=Decimal("1e6"), places=2)
values = st.dictionaries(st.integers(1, 20), _money, min_size=1, max_size=8)


@given(values)
def test_weights_sum_to_100_or_zero(vals: dict[int, Decimal]) -> None:
    w = current_weights_pct(vals)
    assert set(w) == set(vals)
    total = sum(vals.values(), Decimal(0))
    if total == 0:
        assert all(x == 0 for x in w.values())
    else:
        assert abs(sum(w.values(), Decimal(0)) - 100) < Decimal("1e-15")
        assert all(x >= 0 for x in w.values())


def test_weights_golden() -> None:
    assert current_weights_pct({1: Decimal(25), 2: Decimal(75)}) == {
        1: Decimal(25),
        2: Decimal(75),
    }


@given(
    st.integers(1, 6).flatmap(
        lambda n: st.tuples(
            st.lists(_money, min_size=n, max_size=n),
            st.lists(st.integers(1, 100), min_size=n, max_size=n),
            _money,
        )
    )
)
def test_buy_only_plan_conserves_cash(
    case: tuple[list[Decimal], list[int], Decimal],
) -> None:
    vals, raw_w, cash = case
    total_w = sum(raw_w)
    ids = list(range(1, len(vals) + 1))
    targets = {i: Decimal(w) * 100 / Decimal(total_w) for i, w in zip(ids, raw_w, strict=True)}
    current = dict(zip(ids, vals, strict=True))
    plan = plan_rebalance(cash, targets, current)
    assert all(r.add_value >= 0 for r in plan.rows)
    spent = sum((r.add_value for r in plan.rows), Decimal(0))
    assert abs(spent + plan.residual_cash - cash) < Decimal("1e-9")
    assert plan.residual_cash >= -Decimal("1e-9")


def test_buy_only_golden_underweight_gets_cash() -> None:
    plan = plan_rebalance(
        Decimal(100),
        {1: Decimal(50), 2: Decimal(50)},
        {1: Decimal(100), 2: Decimal(0)},
    )
    by_id = {r.instrument_id: r for r in plan.rows}
    assert by_id[1].add_value == 0
    assert by_id[2].add_value == Decimal(100)
