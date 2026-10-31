"""Rebalance assembly extracted from the NiceGUI calculator page."""

from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st
from sqlalchemy.orm import Session

from api._seed import RATE_NOW, seed_ledger
from investment_dashboard.domain.allocation import plan_rebalance
from investment_dashboard.readmodels import rebalance
from investment_dashboard.readmodels.queries.calculator_query import build_calculator_data
from investment_dashboard.repositories import allocations_repo

D = Decimal
HUNDRED = D(100)


@given(
    st.dictionaries(
        st.integers(1, 20), st.decimals(min_value="0.01", max_value="1000", places=2), min_size=1
    )
)
def test_scale_to_100_sums_to_100(weights: dict[int, Decimal]) -> None:
    scaled = rebalance.scale_to_100(weights)
    assert sum(scaled.values()) == pytest.approx(HUNDRED, abs=D("1e-20"))
    assert set(scaled) == set(weights)


def test_scale_and_round_golden() -> None:
    scaled = rebalance.scale_to_100({1: D("1"), 2: D("2"), 3: D("0")})
    assert scaled == {1: HUNDRED / 3, 2: HUNDRED * 2 / 3}
    rounded = rebalance.round_to_100(scaled)
    assert rounded == {1: D("33.3"), 2: D("66.7")}
    assert sum(rounded.values()) == HUNDRED
    assert rebalance.scale_to_100({1: D("0")}) == {}
    assert rebalance.round_to_100({}) == {}


def test_expand_category_targets_value_split_and_errors() -> None:
    members = {"Stocks": [1, 2], "Bonds": [3]}
    values = {1: D("300"), 2: D("100"), 3: D("50")}
    weights = rebalance.expand_category_targets(
        {"Stocks": D("60"), "Bonds": D("40")},
        cat_members=members,
        cat_selected={"Stocks": {1, 2}, "Bonds": {3}},
        cat_split={},
        current_values=values,
    )
    assert sum(weights.values()) == HUNDRED
    assert weights[3] == D("40")
    assert weights[1] == D("45")
    assert weights[2] == D("15")

    with pytest.raises(rebalance.RebalanceInputError, match="at least one category target"):
        rebalance.expand_category_targets(
            {"Stocks": D("0")},
            cat_members=members,
            cat_selected={},
            cat_split={},
            current_values={},
        )
    with pytest.raises(rebalance.RebalanceInputError, match="Tick at least one fund"):
        rebalance.expand_category_targets(
            {"Stocks": D("10")},
            cat_members=members,
            cat_selected={"Stocks": set()},
            cat_split={},
            current_values=values,
        )


def test_held_unticked_extras_only_in_buy_only_category_mode() -> None:
    kwargs = {
        "cat_targets": {"Stocks": D("60")},
        "cat_selected": {"Stocks": {1}},
        "cat_members": {"Stocks": [1, 2, 3]},
        "category_by_id": {1: "Stocks", 2: "Stocks", 3: "Stocks"},
    }
    values = {1: D("100"), 2: D("50"), 3: D("0")}
    target = {1: D("100")}
    extra, category_of = rebalance.held_unticked_extras(
        target,
        values,
        category_mode=True,
        allow_sell=False,
        **kwargs,  # type: ignore[arg-type]
    )
    assert extra == {2}  # held but un-ticked; the zero-value member 3 is ignored
    assert target == {1: D("100"), 2: D("0")}  # mutated in place, as the page relied on
    assert category_of == {1: "Stocks", 2: "Stocks"}

    for mode, sell in ((False, False), (True, True)):
        untouched = {1: D("100")}
        assert rebalance.held_unticked_extras(
            untouched,
            values,
            category_mode=mode,
            allow_sell=sell,
            **kwargs,  # type: ignore[arg-type]
        ) == (set(), None)
        assert untouched == {1: D("100")}


def test_compute_plan_equals_direct_plan_rebalance(session: Session) -> None:
    ids = seed_ledger(session)
    data = build_calculator_data(session)
    target = {ids["VTI"]: D("60"), ids["BND"]: D("40")}
    plan = rebalance.compute_plan(
        data,
        dict(target),
        cash_eur=D("1000"),
        no_buy=set(),
        extra_no_buy=set(),
        category_of=None,
        allow_fractional=True,
        allow_sell=False,
    )
    by_id = data.by_id()
    direct = plan_rebalance(
        D("1000"),
        target,
        {i: by_id[i].current_value_eur for i in target},
        {i: by_id[i].price_eur for i in target},  # type: ignore[misc]
        allow_fractional_shares=True,
        allow_sell=False,
        no_buy_ids=set(),
        category_of=None,
    )
    assert plan == direct
    assert plan.cash_to_invest == D("1000")


def test_build_target_plan_converts_single_instant_only(session: Session) -> None:
    ids = seed_ledger(session)
    allocations_repo.create_allocation(
        session, "t", {ids["VTI"]: D("60"), ids["BND"]: D("40")}, active=True
    )
    eur = rebalance.build_target_plan(session, amount=D("1000"), ccy="EUR", allow_fractional=True)
    usd = rebalance.build_target_plan(
        session, amount=D("1000") * RATE_NOW, ccy="USD", allow_fractional=True
    )
    assert eur.cash_to_invest == D("1000")
    assert usd.cash_to_invest == pytest.approx(D("1000") * RATE_NOW)
    for e, u in zip(eur.rows, usd.rows, strict=True):
        assert e.instrument_id == u.instrument_id
        assert u.add_shares == pytest.approx(e.add_shares, rel=D("1e-9"))
        assert u.add_value == pytest.approx(e.add_value * RATE_NOW, rel=D("1e-9"))
        # USD price shown in USD is the native close.
    prices = {r.symbol: r.current_price for r in usd.rows}
    assert prices["VTI"] == pytest.approx(D("250"))
    assert prices["BND"] == pytest.approx(D("70"))


def test_build_target_plan_input_errors(session: Session) -> None:
    ids = seed_ledger(session)
    with pytest.raises(rebalance.RebalanceInputError, match="No target"):
        rebalance.build_target_plan(session, amount=D("10"), ccy="EUR")
    allocations_repo.create_allocation(session, "t", {ids["VTI"]: D("100")}, active=True)
    with pytest.raises(rebalance.RebalanceInputError):
        rebalance.build_target_plan(session, amount=D("0"), ccy="EUR")
    with pytest.raises(rebalance.RebalanceInputError):
        rebalance.build_target_plan(session, amount=D("-1"), ccy="EUR")
