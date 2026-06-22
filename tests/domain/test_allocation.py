"""Tests for ``investment_dashboard.domain.allocation``."""

from __future__ import annotations

from decimal import Decimal

import pytest

from investment_dashboard.domain.allocation import (
    current_weights_pct,
    expand_category_weights,
    plan_rebalance,
)


def test_rebalance_pure_proportional_no_holdings() -> None:
    # Brand-new portfolio, 1000 EUR to invest, two instruments 60/40.
    plan = plan_rebalance(
        cash_to_invest=Decimal(1000),
        target_weights_pct={1: Decimal(60), 2: Decimal(40)},
        current_values={},
        current_prices={1: Decimal(10), 2: Decimal(20)},
    )
    by_id = {r.instrument_id: r for r in plan.rows}
    # Gaps are 600/400 ⇒ both fit within 1000 exactly.
    assert by_id[1].add_value == Decimal(600)
    assert by_id[2].add_value == Decimal(400)
    # Floored shares: 600/10 = 60, 400/20 = 20.
    assert by_id[1].add_shares == Decimal(60)
    assert by_id[2].add_shares == Decimal(20)
    assert plan.residual_cash == Decimal(0)


def test_rebalance_caps_gaps_at_cash_to_invest() -> None:
    # User is far from target on both, but only has 100 to invest.
    plan = plan_rebalance(
        cash_to_invest=Decimal(100),
        target_weights_pct={1: Decimal(50), 2: Decimal(50)},
        current_values={1: Decimal(0), 2: Decimal(0)},
        current_prices={1: Decimal(1), 2: Decimal(1)},
    )
    total_added = sum(r.add_value for r in plan.rows)
    assert total_added <= Decimal(100)


def test_rebalance_with_existing_overshoot() -> None:
    # 60/40 target, but currently 100% in #1 with value 1000. 100 cash.
    # Total after = 1100, target_value: #1=660, #2=440. Gap: #1=0 (already
    # over), #2=440. Cash is 100 so gap_total > cash, scale ⇒ #2 gets 100.
    plan = plan_rebalance(
        cash_to_invest=Decimal(100),
        target_weights_pct={1: Decimal(60), 2: Decimal(40)},
        current_values={1: Decimal(1000), 2: Decimal(0)},
        current_prices={1: Decimal(50), 2: Decimal(10)},
    )
    by_id = {r.instrument_id: r for r in plan.rows}
    assert by_id[1].add_value == Decimal(0)
    assert by_id[2].add_value == Decimal(100)


def test_fractional_shares_toggle() -> None:
    plan = plan_rebalance(
        cash_to_invest=Decimal(50),
        target_weights_pct={1: Decimal(100)},
        current_values={},
        current_prices={1: Decimal(7)},  # 50/7 ≈ 7.142857
        allow_fractional_shares=True,
    )
    row = plan.rows[0]
    assert row.add_shares == Decimal("7.1429")


def test_floored_shares_residual() -> None:
    plan = plan_rebalance(
        cash_to_invest=Decimal(50),
        target_weights_pct={1: Decimal(100)},
        current_values={},
        current_prices={1: Decimal(7)},  # floor(50/7) = 7 shares = 49 EUR
    )
    row = plan.rows[0]
    assert row.add_shares == Decimal(7)
    assert row.add_value == Decimal(49)
    assert plan.residual_cash == Decimal(1)


def test_missing_price_zero_shares() -> None:
    plan = plan_rebalance(
        cash_to_invest=Decimal(100),
        target_weights_pct={1: Decimal(100)},
        current_values={},
        current_prices=None,
    )
    assert plan.rows[0].add_shares == Decimal(0)
    assert plan.rows[0].add_value == Decimal(100)


def test_invalid_weights_raise() -> None:
    with pytest.raises(ValueError, match="sum to 100"):
        plan_rebalance(
            cash_to_invest=Decimal(100),
            target_weights_pct={1: Decimal(60), 2: Decimal(30)},
            current_values={},
        )


def test_negative_cash_raises() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        plan_rebalance(
            cash_to_invest=Decimal(-1),
            target_weights_pct={1: Decimal(100)},
            current_values={},
        )


# --- current_weights_pct -------------------------------------------------


def test_current_weights_pct_basic() -> None:
    weights = current_weights_pct({1: Decimal(75), 2: Decimal(25)})
    assert weights[1] == Decimal(75)
    assert weights[2] == Decimal(25)
    assert sum(weights.values()) == Decimal(100)


def test_current_weights_pct_zero_total_is_all_zero() -> None:
    weights = current_weights_pct({1: Decimal(0), 2: Decimal(0)})
    assert weights == {1: Decimal(0), 2: Decimal(0)}


# --- expand_category_weights --------------------------------------------


def test_expand_category_split_by_value() -> None:
    # "International" gets 10 %, split across two funds by current value (3:1).
    weights = expand_category_weights(
        category_weights_pct={"International": Decimal(10), "US": Decimal(90)},
        selected_by_category={"International": [1, 2], "US": [3]},
        current_values={1: Decimal(300), 2: Decimal(100), 3: Decimal(1000)},
        split="value",
    )
    assert weights[1] == Decimal("7.5")
    assert weights[2] == Decimal("2.5")
    assert weights[3] == Decimal(90)
    assert sum(weights.values()) == Decimal(100)


def test_expand_category_split_equal() -> None:
    weights = expand_category_weights(
        category_weights_pct={"International": Decimal(10)},
        selected_by_category={"International": [1, 2]},
        current_values={1: Decimal(300), 2: Decimal(100)},
        split="equal",
    )
    assert weights[1] == Decimal(5)
    assert weights[2] == Decimal(5)


def test_expand_category_value_falls_back_to_equal_when_no_value() -> None:
    # Brand-new category — funds carry no value yet, so split evenly.
    weights = expand_category_weights(
        category_weights_pct={"New": Decimal(20)},
        selected_by_category={"New": [1, 2]},
        current_values={},
        split="value",
    )
    assert weights[1] == Decimal(10)
    assert weights[2] == Decimal(10)


def test_expand_category_skips_zero_weight_categories() -> None:
    weights = expand_category_weights(
        category_weights_pct={"A": Decimal(100), "B": Decimal(0)},
        selected_by_category={"A": [1], "B": []},
        current_values={1: Decimal(50)},
    )
    assert weights == {1: Decimal(100)}


def test_expand_category_empty_selection_raises() -> None:
    with pytest.raises(ValueError, match="no funds selected"):
        expand_category_weights(
            category_weights_pct={"A": Decimal(100)},
            selected_by_category={"A": []},
            current_values={},
        )


def test_expand_category_instrument_in_two_categories_accumulates() -> None:
    weights = expand_category_weights(
        category_weights_pct={"A": Decimal(40), "B": Decimal(60)},
        selected_by_category={"A": [1], "B": [1]},
        current_values={1: Decimal(10)},
    )
    assert weights == {1: Decimal(100)}
