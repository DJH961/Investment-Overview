"""Window growth beside the value graph: golden values + properties."""

from __future__ import annotations

import math
from datetime import date, timedelta
from decimal import Decimal

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain import returns
from investment_dashboard.domain.returns import Cashflow, modified_dietz, window_growth

D = Decimal
START = date(2025, 1, 1)


def _close(a: Decimal, b: float, rel: float = 1e-6) -> bool:
    return math.isclose(float(a), b, rel_tol=rel, abs_tol=1e-9)


# -- golden values (hand-derived) ---------------------------------------------


def test_modified_dietz_golden_mid_window_deposit() -> None:
    # 1000 open, +100 deposited half-way (15 of 30 days left), 1150 close:
    # (1150 - 1000 - 100) / (1000 + 100 * 0.5) = 50 / 1050.
    got = modified_dietz(
        opening_date=date(2025, 1, 1),
        opening_value=D(1000),
        closing_date=date(2025, 1, 31),
        closing_value=D(1150),
        flows=[Cashflow(date(2025, 1, 16), D(-100))],
    )
    assert got == D(50) / D(1050)


def test_xirr_golden_one_year_no_flows() -> None:
    got = window_growth(
        mode="xirr",
        opening_date=START,
        opening_value=D(1000),
        closing_date=START + timedelta(days=365),
        closing_value=D(1100),
    )
    assert got is not None
    assert got.mode == "xirr"
    assert _close(got.pct, 0.1)


def test_xirr_golden_deposit_on_closing_day() -> None:
    # -1000 (1+r) - 1000 + 2100 = 0  =>  r = 10 %, over exactly one year.
    end = START + timedelta(days=365)
    got = window_growth(
        mode="xirr",
        opening_date=START,
        opening_value=D(1000),
        closing_date=end,
        closing_value=D(2100),
        flows=[Cashflow(end, D(-1000))],
    )
    assert got is not None
    assert _close(got.pct, 0.1)


def test_xirr_golden_half_year_with_quarter_deposit() -> None:
    # 1000 at day 0, 500 at day 91, 1600 at day 182. With x = (1+r)^(91/365):
    # 1000 x^2 + 500 x = 1600  =>  growth over the window = x^2 - 1.
    x = (-500 + math.sqrt(500**2 + 4 * 1000 * 1600)) / 2000
    got = window_growth(
        mode="xirr",
        opening_date=START,
        opening_value=D(1000),
        closing_date=START + timedelta(days=182),
        closing_value=D(1600),
        flows=[Cashflow(START + timedelta(days=91), D(-500))],
    )
    assert got is not None
    assert got.mode == "xirr"
    assert _close(got.pct, x * x - 1, rel=1e-5)


def test_reference_mode_is_move_from_previous_close() -> None:
    got = window_growth(
        mode="reference",
        opening_date=START,
        opening_value=D(990),
        closing_date=START,
        closing_value=D(1010),
        reference=D(1000),
    )
    assert got == returns.WindowGrowth(D("0.01"), "reference")


def test_reference_mode_without_reference_is_none() -> None:
    assert (
        window_growth(
            mode="reference",
            opening_date=START,
            opening_value=D(1),
            closing_date=START,
            closing_value=D(2),
        )
        is None
    )


def test_flow_on_opening_day_is_already_in_the_opening_value() -> None:
    got = modified_dietz(
        opening_date=START,
        opening_value=D(1000),
        closing_date=START + timedelta(days=7),
        closing_value=D(1010),
        flows=[Cashflow(START, D(-1000))],
    )
    assert got == D("0.01")


def test_xirr_falls_back_to_simple_when_solver_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(returns, "xirr", lambda *_a, **_k: None)
    flows = [Cashflow(START + timedelta(days=10), D(-200))]
    got = window_growth(
        mode="xirr",
        opening_date=START,
        opening_value=D(1000),
        closing_date=START + timedelta(days=40),
        closing_value=D(1300),
        flows=flows,
    )
    assert got is not None
    assert got.mode == "simple"
    assert got.pct == modified_dietz(
        opening_date=START,
        opening_value=D(1000),
        closing_date=START + timedelta(days=40),
        closing_value=D(1300),
        flows=flows,
    )


@pytest.mark.parametrize("opening", [None, D(0), D(-5)])
def test_no_opening_value_is_none(opening: Decimal | None) -> None:
    for mode in ("simple", "xirr"):
        assert (
            window_growth(
                mode=mode,  # type: ignore[arg-type]
                opening_date=START,
                opening_value=opening,
                closing_date=START + timedelta(days=30),
                closing_value=D(100),
            )
            is None
        )


def test_total_mode_is_not_computed_here() -> None:
    assert (
        window_growth(
            mode="total",
            opening_date=START,
            opening_value=D(1),
            closing_date=START + timedelta(days=30),
            closing_value=D(2),
        )
        is None
    )


# -- properties ---------------------------------------------------------------

values = st.decimals(min_value=D(100), max_value=D(1_000_000), places=2)
ratios = st.decimals(min_value=D("0.5"), max_value=D("2"), places=4)
spans = st.integers(min_value=1, max_value=3 * 365)


@settings(max_examples=60, deadline=None)
@given(opening=values, ratio=ratios, span=spans, mode=st.sampled_from(["simple", "xirr"]))
def test_zero_flows_is_the_simple_ratio(
    opening: Decimal, ratio: Decimal, span: int, mode: str
) -> None:
    closing = opening * ratio
    got = window_growth(
        mode=mode,  # type: ignore[arg-type]
        opening_date=START,
        opening_value=opening,
        closing_date=START + timedelta(days=span),
        closing_value=closing,
    )
    assert got is not None
    assert _close(got.pct, float(closing / opening - 1), rel=1e-5)
    if got.mode == "simple":
        assert got.pct == closing / opening - 1


@settings(max_examples=60, deadline=None)
@given(
    opening=values,
    ratio=ratios,
    deposit=values,
    deposit_day=st.integers(min_value=1, max_value=89),
    k=st.decimals(min_value=D("0.01"), max_value=D(100), places=2),
    mode=st.sampled_from(["simple", "xirr"]),
)
def test_scaling_invariance(
    opening: Decimal, ratio: Decimal, deposit: Decimal, deposit_day: int, k: Decimal, mode: str
) -> None:
    end = START + timedelta(days=90)
    closing = (opening + deposit) * ratio

    def run(scale: Decimal) -> returns.WindowGrowth | None:
        return window_growth(
            mode=mode,  # type: ignore[arg-type]
            opening_date=START,
            opening_value=opening * scale,
            closing_date=end,
            closing_value=closing * scale,
            flows=[Cashflow(START + timedelta(days=deposit_day), -deposit * scale)],
        )

    base, scaled = run(D(1)), run(k)
    assert (base is None) == (scaled is None)
    if base is not None and scaled is not None:
        assert base.mode == scaled.mode
        assert _close(scaled.pct, float(base.pct), rel=1e-5)


@settings(max_examples=60, deadline=None)
@given(opening=values, deposit=values, deposit_day=st.integers(min_value=1, max_value=29))
def test_a_deposit_alone_is_not_growth(
    opening: Decimal, deposit: Decimal, deposit_day: int
) -> None:
    # Value rises only by the money paid in: every mode reads 0 %.
    for mode in ("simple", "xirr"):
        got = window_growth(
            mode=mode,  # type: ignore[arg-type]
            opening_date=START,
            opening_value=opening,
            closing_date=START + timedelta(days=30),
            closing_value=opening + deposit,
            flows=[Cashflow(START + timedelta(days=deposit_day), -deposit)],
        )
        assert got is not None
        assert abs(float(got.pct)) < 1e-6
