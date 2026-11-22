"""Golden + property tests for the "The dollar" additions to ``domain.fx_trend`` (v7.2).

Hand-made rate series only; every hand calculation is written next to its assertion.
Rates are USD per 1 EUR; the dollar's terms are the inverse (1 / rate).
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from decimal import Decimal

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain import fx_trend

D0 = date(2020, 1, 1)


def _rates(values: list[str]) -> list[tuple[date, Decimal]]:
    return [(D0 + timedelta(days=i), Decimal(v)) for i, v in enumerate(values)]


# --- quantile ------------------------------------------------------------------


def test_quantile_golden() -> None:
    xs = [Decimal(v) for v in ("4", "1", "3", "2")]
    # sorted 1,2,3,4; h = 3 * 0.8 = 2.4 -> 3 + 0.4 * (4 - 3) = 3.4
    assert fx_trend.quantile(xs, Decimal("0.8")) == Decimal("3.4")
    assert fx_trend.quantile(xs, Decimal(0)) == 1
    assert fx_trend.quantile(xs, Decimal(1)) == 4
    # h = 3 * 0.5 = 1.5 -> 2 + 0.5 = 2.5 (the median)
    assert fx_trend.quantile(xs, Decimal("0.5")) == Decimal("2.5")
    assert fx_trend.quantile([Decimal(5)], Decimal("0.3")) == 5


def test_quantile_rejects_bad_input() -> None:
    with pytest.raises(ValueError, match="quantile of an empty sequence"):
        fx_trend.quantile([], Decimal("0.5"))
    with pytest.raises(ValueError, match=r"q must be in \[0, 1\]"):
        fx_trend.quantile([Decimal(1)], Decimal("1.5"))


# --- trailing moves and the normal band ----------------------------------------


def test_trailing_moves_and_band_golden() -> None:
    series = _rates(["2", "1", "4"])  # inverses 0.5, 1, 0.25
    moves = fx_trend.trailing_moves(series, 1)
    # 1 / 0.5 - 1 = 1 ; 0.25 / 1 - 1 = -0.75
    assert moves == [
        (D0 + timedelta(days=1), Decimal(1)),
        (D0 + timedelta(days=2), Decimal("-0.75")),
    ]
    band = fx_trend.move_band(series, 1)
    assert band is not None
    # |moves| 1, 0.75: median 0.875; q80: h = 0.8 -> 0.75 + 0.8 * 0.25 = 0.95
    assert band.typical_move_pct == Decimal("0.875")
    assert band.normal_limit_pct == Decimal("0.95")
    assert fx_trend.move_band(series, 3) is None


# --- MA200 slope ---------------------------------------------------------------


def test_ma_slope_golden() -> None:
    series = _rates(["1", "1", "0.5"])  # inverses 1, 1, 2
    s = fx_trend.ma_slope(series, window=2, slope_days=1)
    assert s is not None
    # MA2 of the inverse: 1, 1.5 -> slope 1.5 / 1 - 1 = 0.5, rising
    assert s.ma_now == Decimal("1.5")
    assert s.ma_then == 1
    assert s.slope_pct == Decimal("0.5")
    assert s.label == "rising"
    # inverse 2 above 1.5: 2 / 1.5 - 1 = 1/3
    assert s.side == "above"
    assert s.distance_pct == Decimal(2) / Decimal("1.5") - 1
    # MA2 of the rate: (1 + 0.5) / 2
    assert s.ma_rate_now == Decimal("0.75")


def test_ma_slope_flat_and_short() -> None:
    flat = _rates(["1.1"] * 5)
    s = fx_trend.ma_slope(flat, window=2, slope_days=1)
    assert s is not None
    assert s.label == "flat"
    assert s.slope_pct == 0
    assert fx_trend.ma_slope(flat, window=5, slope_days=1) is None


# --- shares, mean --------------------------------------------------------------


def test_shares_golden() -> None:
    series = _rates(["1.0", "1.1", "1.2", "1.3"])
    assert fx_trend.share_below(series, Decimal("1.15")) == Decimal("0.5")
    assert fx_trend.share_above(series, Decimal("1.15")) == Decimal("0.5")
    # from day 2: 1.2, 1.3 -> none below 1.15
    assert fx_trend.share_below(series, Decimal("1.15"), D0 + timedelta(days=2)) == 0
    # strict comparisons: 1.1 itself is neither below nor above
    assert fx_trend.share_below(series, Decimal("1.1")) == Decimal("0.25")
    assert fx_trend.share_above(series, Decimal("1.1")) == Decimal("0.5")
    assert fx_trend.share_below([], Decimal(1)) is None


def test_series_mean_golden() -> None:
    m = fx_trend.series_mean(_rates(["2", "4"]))
    assert m is not None
    # rate (2 + 4) / 2 = 3 ; inverse (0.5 + 0.25) / 2 = 0.375
    assert m.rate == 3
    assert m.inverse == Decimal("0.375")
    assert m.since == D0
    assert m.rows == 2
    assert fx_trend.series_mean(_rates(["2"]), D0 + timedelta(days=5)) is None


# --- monthly run ---------------------------------------------------------------


def _month_ends(values: list[str]) -> list[tuple[date, Decimal]]:
    """Two rows per month (the 1st and the 15th); the month end is the 15th's value."""
    out: list[tuple[date, Decimal]] = []
    for m, v in enumerate(values):
        first = date(2021 + m // 12, m % 12 + 1, 1)
        out.append((first, Decimal("9")))  # ignored: not the month's last row
        out.append((first.replace(day=15), Decimal(v)))
    return out


def test_monthly_run_golden() -> None:
    # Month ends 1.0, 1.1, 1.2, 1.1, 1.3, 1.4, 1.5: the rate rose in 5 of the last 6
    # months (Feb, Mar, May, Jun, Jul), so the dollar FELL in 5 of 6.
    run = fx_trend.monthly_run(_month_ends(["1.0", "1.1", "1.2", "1.1", "1.3", "1.4", "1.5"]))
    assert run == fx_trend.MonthRun(direction="fell", count=5, of=6)


def test_monthly_run_tie_takes_latest_and_needs_history() -> None:
    # Ends 1.0, 1.1, 1.0: rate up (dollar fell) then down (dollar rose) -> tie -> latest.
    run = fx_trend.monthly_run(_month_ends(["1.0", "1.1", "1.0"]), months=2)
    assert run == fx_trend.MonthRun(direction="rose", count=1, of=2)
    assert fx_trend.monthly_run(_month_ends(["1.0", "1.1"]), months=2) is None
    assert fx_trend.monthly_run(_month_ends(["1.0", "1.0", "1.0"]), months=2) is None


# --- volatility ----------------------------------------------------------------


def test_rate_volatility_golden() -> None:
    # returns +0.1, -0.1: mean 0, sample var (0.01 + 0.01) / 1 = 0.02 -> sqrt(0.02 * 252)
    vol = fx_trend.rate_volatility(_rates(["1", "1.1", "0.99"]))
    assert vol is not None
    assert float(vol) == pytest.approx(math.sqrt(0.02 * 252))
    assert fx_trend.rate_volatility(_rates(["1", "1.1"])) is None


# --- properties ----------------------------------------------------------------

_rate_lists = st.lists(st.decimals("0.8", "1.6", places=4), min_size=3, max_size=60)


@settings(max_examples=40, deadline=None)
@given(
    st.lists(st.decimals("-5", "5", places=3), min_size=1, max_size=40),
    st.decimals("0", "1", places=2),
)
def test_quantile_is_bounded_and_monotone(xs: list[Decimal], q: Decimal) -> None:
    v = fx_trend.quantile(xs, q)
    assert min(xs) <= v <= max(xs)
    assert fx_trend.quantile(xs, Decimal(0)) <= v <= fx_trend.quantile(xs, Decimal(1))


@settings(max_examples=40, deadline=None)
@given(_rate_lists, st.integers(min_value=1, max_value=5))
def test_trailing_move_matches_rate_ratio(values: list[Decimal], w: int) -> None:
    series = [(D0 + timedelta(days=i), v) for i, v in enumerate(values)]
    moves = fx_trend.trailing_moves(series, w)
    assert len(moves) == max(len(values) - w, 0)
    for k, (_d, m) in enumerate(moves):
        i = k + w
        # dollar change == rate[i - w] / rate[i] - 1
        assert abs((1 + m) - values[i - w] / values[i]) < Decimal("1e-20")
    band = fx_trend.move_band(series, w)
    if band is not None:
        assert 0 <= band.typical_move_pct <= max(abs(m) for _d, m in moves)
        assert band.normal_limit_pct <= max(abs(m) for _d, m in moves)


@settings(max_examples=40, deadline=None)
@given(_rate_lists, st.decimals("0.8", "1.6", places=4))
def test_shares_partition(values: list[Decimal], threshold: Decimal) -> None:
    series = [(D0 + timedelta(days=i), v) for i, v in enumerate(values)]
    below = fx_trend.share_below(series, threshold)
    above = fx_trend.share_above(series, threshold)
    assert below is not None
    assert above is not None
    equal = Decimal(sum(1 for v in values if v == threshold)) / len(values)
    # Decimal division rounds repeating fractions to the current context precision.
    # Compare within one final-place rounding unit instead of requiring exact
    # arithmetic equality for values such as 1/3 + 1/3 + 1/3.
    assert abs(below + above + equal - 1) <= Decimal("1e-27")


@settings(max_examples=30, deadline=None)
@given(_rate_lists, st.integers(min_value=-2, max_value=2))
def test_run_and_slope_invariant_under_scaling(values: list[Decimal], power: int) -> None:
    """Scaling every rate by 10^k changes no direction, share or relative figure."""
    k = Decimal(10) ** power
    series = [(D0 + timedelta(days=30 * i), v) for i, v in enumerate(values)]
    scaled = [(d, v * k) for d, v in series]
    assert fx_trend.monthly_run(series, 2) == fx_trend.monthly_run(scaled, 2)
    a = fx_trend.ma_slope(series, window=2, slope_days=1)
    b = fx_trend.ma_slope(scaled, window=2, slope_days=1)
    assert (a is None) == (b is None)
    if a is not None and b is not None:
        assert a.label == b.label
        assert a.side == b.side
        assert abs(a.slope_pct - b.slope_pct) < Decimal("1e-20")
