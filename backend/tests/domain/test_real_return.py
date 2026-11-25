"""Real euro return: golden values worked by hand plus properties (7.4 P10)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.real_return import (
    chained_ratio,
    label_months,
    month_before,
    months_between,
    period_real_return,
    real_return,
)

D = Decimal


# -- golden values (by hand) ---------------------------------------------------------


def test_golden_ten_percent_against_two_percent_inflation() -> None:
    # 1.10 / 1.02 - 1 = 0.0784313725... (+7.843 %)
    assert round(real_return(D("0.10"), D("1.02")), 6) == D("0.078431")


def test_golden_month_from_the_index() -> None:
    # Index 100 at the end of Sep, 102 at the end of Oct; nominal +10 % in Oct.
    index = {"2026-09": D(100), "2026-10": D(102)}
    got = period_real_return(D("0.10"), index, first_month="2026-10", last_month="2026-10")
    assert got is not None
    assert got.to_month == "2026-10"
    assert round(got.value, 6) == D("0.078431")


def test_golden_loss_with_deflation() -> None:
    # -5 % nominal while prices fell 1 %: 0.95 / 0.99 - 1 = -0.040404...
    index = {"2026-01": D(100), "2026-02": D(99)}
    got = period_real_return(D("-0.05"), index, first_month="2026-02", last_month="2026-02")
    assert got is not None
    assert round(got.value, 6) == D("-0.040404")


def test_golden_year_runs_from_the_previous_december() -> None:
    # 2025: Dec 2024 = 100, Dec 2025 = 103 (every month in between on file).
    index = {f"2025-{m:02d}": D(100) + D(m) * D("0.25") for m in range(1, 13)}
    index["2024-12"] = D(100)
    got = period_real_return(D("0.15"), index, first_month="2025-01", last_month="2025-12")
    assert got is not None
    assert got.to_month == "2025-12"
    # 1.15 / 1.03 - 1 = 0.116504854...
    assert round(got.value, 6) == D("0.116505")


def test_late_index_uses_the_latest_month_and_says_so() -> None:
    # 2026 so far, the index is out to October only.
    index = {"2025-12": D(100), **{f"2026-{m:02d}": D(100) + D(m) for m in range(1, 11)}}
    got = period_real_return(D("0.21"), index, first_month="2026-01", last_month="2026-12")
    assert got is not None
    assert got.to_month == "2026-10"
    # 1.21 / 1.10 - 1 = 0.10
    assert got.value == D("0.1")


def test_running_month_has_no_real_return_yet() -> None:
    index = {"2026-09": D(100), "2026-10": D(101)}
    assert period_real_return(D("0.01"), index, first_month="2026-11", last_month="2026-11") is None


def test_missing_start_or_nominal_is_none() -> None:
    index = {"2026-10": D(101)}
    assert period_real_return(D("0.01"), index, first_month="2026-10", last_month="2026-10") is None
    assert (
        period_real_return(
            None, {"2026-09": D(1), "2026-10": D(1)}, first_month="2026-10", last_month="2026-10"
        )
        is None
    )


def test_a_gap_inside_the_chain_is_none() -> None:
    index = {"2026-01": D(100), "2026-03": D(101)}
    assert chained_ratio(index, "2026-01", "2026-03") is None


def test_month_helpers() -> None:
    assert month_before("2026-01") == "2025-12"
    assert month_before("2026-10") == "2026-09"
    assert months_between("2025-11", "2026-02") == ["2025-12", "2026-01", "2026-02"]
    assert months_between("2026-02", "2026-02") == []
    assert label_months("2026") == ("2026-01", "2026-12")
    assert label_months("2026-04") == ("2026-04", "2026-04")


def test_ratio_must_be_positive() -> None:
    with pytest.raises(ValueError, match="positive"):
        real_return(D("0.1"), D(0))


# -- properties ----------------------------------------------------------------------

rates = st.decimals(min_value=D("-0.5"), max_value=D("0.5"), places=6)
levels = st.decimals(min_value=D(50), max_value=D(200), places=2)


@given(nominal=rates)
def test_no_inflation_means_real_equals_nominal(nominal: Decimal) -> None:
    assert real_return(nominal, D(1)) == nominal


@given(nominal=rates, ratio=st.decimals(min_value=D("0.8"), max_value=D("1.3"), places=4))
def test_real_is_below_nominal_exactly_when_prices_rose(nominal: Decimal, ratio: Decimal) -> None:
    real = real_return(nominal, ratio)
    if ratio > 1:
        assert real < nominal
    elif ratio < 1:
        assert real > nominal
    # And it inverts: (1 + real) * ratio == 1 + nominal.
    assert abs((1 + real) * ratio - (1 + nominal)) < D("1e-20")


@given(
    monthly=st.lists(st.tuples(rates, levels), min_size=1, max_size=12),
    start=levels,
)
def test_year_equals_the_chain_of_its_months(
    monthly: list[tuple[Decimal, Decimal]], start: Decimal
) -> None:
    """Chained over months: Π(1 + real_m) == (1 + nominal_year) / (H[m1] / H[m0])
    whenever the year's nominal return is the chain of the months' returns."""
    index = {"2024-12": start}
    month_labels = [f"2025-{i + 1:02d}" for i in range(len(monthly))]
    for label, (_, level) in zip(month_labels, monthly, strict=True):
        index[label] = level
    chain_real = D(1)
    chain_nominal = D(1)
    for label, (nominal, _) in zip(month_labels, monthly, strict=True):
        got = period_real_return(nominal, index, first_month=label, last_month=label)
        assert got is not None
        chain_real *= 1 + got.value
        chain_nominal *= 1 + nominal
    year = period_real_return(
        chain_nominal - 1, index, first_month="2025-01", last_month=month_labels[-1]
    )
    assert year is not None
    assert year.to_month == month_labels[-1]
    assert abs((1 + year.value) - chain_real) < D("1e-18")
