"""Golden + property tests for ``domain.fx_trend`` (the dollar's trend, v7.2).

Synthetic series only. Golden series are chosen so every inverse (1 / rate) is an
exact decimal (rates 1, 0.8, 0.5, 0.4, 0.25, 2, 1.25 ...), and the hand
calculations are written next to each assertion.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain import fx_trend

D0 = date(2020, 1, 1)


def _series(inverses: list[str]) -> list[tuple[date, Decimal]]:
    """Daily series whose rate is ``1 / inverse`` (all exact)."""
    return [(D0 + timedelta(days=i), Decimal(1) / Decimal(v)) for i, v in enumerate(inverses)]


def _day(i: int) -> date:
    return D0 + timedelta(days=i)


# --- moving_average ----------------------------------------------------------


def test_moving_average_golden() -> None:
    pts = [(i, Decimal(v)) for i, v in enumerate(["1", "2", "3", "4", "5"])]
    # window 3: (1+2+3)/3=2, (2+3+4)/3=3, (3+4+5)/3=4, keyed by the window's last row
    assert fx_trend.moving_average(pts, 3) == [(2, Decimal(2)), (3, Decimal(3)), (4, Decimal(4))]
    assert fx_trend.moving_average(pts[:2], 3) == []


# --- regime ------------------------------------------------------------------

_SMALL = {"window": 3, "slope_days": 2, "sideways_days": 2}


def test_regime_golden_up_sideways_down() -> None:
    """Hand calculation, window 3, slope over 2 rows, 2 in-band days -> sideways.

    inverse:  i0..i3 = 1, i4 = 2, i5..i9 = 4, i10 = 0.5, i11 = 0.8
    MA3:      i2 = 1, i3 = 1, i4 = 4/3, i5 = 7/3, i6 = 10/3, i7..i9 = 4,
              i10 = 8.5/3 = 2.8333, i11 = 5.3/3 = 1.7667
    First evaluable row is i4 (needs MA two rows back, i2):
      i4: 2 > 4/3 * 1.005 and 4/3 > 1 (rising)       -> dollar_up since i4
      i5, i6: still above and rising                   -> keep
      i7: 4 within 0.5 % of MA 4 -> in-band run starts at i7 (1 day)
      i8: in band again (2 days)                       -> sideways since i7
      i9: sideways (no condition)
      i10: 0.5 < 2.8333 * 0.995 and 2.8333 < MA(i8)=4  -> dollar_down since i10
      i11: 0.8 < 1.7667 * 0.995, falling               -> keep down
    since_change = 0.8 / 0.5 - 1 = 0.6; today 0.8 < MA 1.7667 -> below.
    """
    inv = ["1", "1", "1", "1", "2", "4", "4", "4", "4", "4", "0.5", "0.8"]
    up = fx_trend.regime(_series(inv[:7]), **_SMALL)
    assert up is not None
    assert (up.direction, up.since, up.vs_ma200) == ("dollar_up", _day(4), "above")
    assert up.since_change_pct == Decimal(1)  # 4 / 2 - 1

    side = fx_trend.regime(_series(inv[:10]), **_SMALL)
    assert side is not None
    assert (side.direction, side.since) == ("sideways", _day(7))
    assert side.since_change_pct == 0

    down = fx_trend.regime(_series(inv), **_SMALL)
    assert down is not None
    assert (down.direction, down.since, down.vs_ma200) == ("dollar_down", _day(10), "below")
    assert down.since_change_pct == Decimal("0.6")


def test_regime_hysteresis_keeps_trend_after_one_band_day() -> None:
    """i7 is one in-band day (4 vs MA 4); i8 jumps to 5 (out of band, above, so not
    the down condition): the run resets and the trend stays dollar_up since i4."""
    inv = ["1", "1", "1", "1", "2", "4", "4", "4", "5"]
    reg = fx_trend.regime(_series(inv), **_SMALL)
    assert reg is not None
    assert (reg.direction, reg.since) == ("dollar_up", _day(4))


def test_regime_needs_enough_history() -> None:
    assert fx_trend.regime(_series(["1"] * 219)) is None  # 200 + 20 rows needed
    assert fx_trend.regime(_series(["1"] * 221)) is not None


# --- move_normality ----------------------------------------------------------


def test_move_normality_golden() -> None:
    """inverse 1, 1.25, 1, 2, 2.5 with a 1-row window.

    moves: 0.25, -0.2, 1, 0.25; today 0.25; |moves| sorted .2 .25 .25 1
    below = 1, equal = 2 -> (1 + 0.5*2) / 4 = 0.5 (normal); median = 0.25.
    """
    res = fx_trend.move_normality(_series(["1", "1.25", "1", "2", "2.5"]), window_days=1)
    assert res is not None
    assert res.move_pct == Decimal("0.25")
    assert res.percentile == Decimal("0.5")
    assert res.typical_move_pct == Decimal("0.25")
    assert res.label == "normal"


def test_move_normality_large_and_unusual() -> None:
    # moves 0,0,0,1: below 3, equal 1 -> 3.5/4 = 0.875 -> large; median 0
    res = fx_trend.move_normality(_series(["1", "1", "1", "1", "2"]), window_days=1)
    assert res is not None
    assert (res.percentile, res.label, res.typical_move_pct) == (Decimal("0.875"), "large", 0)
    # 19 zero moves then one: (19 + 0.5) / 20 = 0.975 -> unusual
    res = fx_trend.move_normality(_series(["1"] * 20 + ["2"]), window_days=1)
    assert res is not None
    assert (res.percentile, res.label) == (Decimal("0.975"), "unusual")
    assert fx_trend.move_normality(_series(["1"] * 21)) is None  # needs 22 rows


def test_label_thresholds() -> None:
    assert fx_trend.label_for(Decimal("0.7999")) == "normal"
    assert fx_trend.label_for(Decimal("0.80")) == "large"
    assert fx_trend.label_for(Decimal("0.9499")) == "large"
    assert fx_trend.label_for(Decimal("0.95")) == "unusual"


# --- rate_percentiles / range_extremes ---------------------------------------


def test_rate_percentiles_golden() -> None:
    series = [(_day(i), Decimal(r)) for i, r in enumerate(["1.0", "1.1", "1.2", "1.3"])]
    out = fx_trend.rate_percentiles(
        series,
        Decimal("1.15"),
        {"all": _day(0), "late": _day(2), "none": None, "too_early": _day(-100)},
    )
    # rate > 1.15 (dollar cheaper) on 1.2 and 1.3: 2 of 4; since day 2: 2 of 2
    assert out == {"all": Decimal("0.5"), "late": Decimal(1), "none": None, "too_early": None}


def test_range_extremes_golden() -> None:
    pts = [
        ("a", Decimal("1.1")),
        ("b", Decimal("1.0")),
        ("c", Decimal("1.2")),
        ("d", Decimal("1.0")),
    ]
    ext = fx_trend.range_extremes(pts)
    assert ext is not None
    assert (ext.low_at, ext.low, ext.high_at, ext.high) == (
        "b",
        Decimal("1.0"),
        "c",
        Decimal("1.2"),
    )
    assert fx_trend.range_extremes([]) is None


# --- properties ----------------------------------------------------------------

_steps = st.lists(st.integers(min_value=-40, max_value=40), min_size=221, max_size=320)


def _walk(steps: list[int]) -> list[tuple[date, Decimal]]:
    rate = Decimal("1.1000")
    out = []
    for i, s in enumerate(steps):
        rate = max(Decimal("0.5"), rate + Decimal(s) / 10000)
        out.append((_day(i), rate))
    return out


@settings(max_examples=25, deadline=None)
@given(st.integers(min_value=221, max_value=300), st.decimals("0.5", "2", places=4))
def test_flat_series_is_sideways_and_sane(n: int, rate: Decimal) -> None:
    series = [(_day(i), rate) for i in range(n)]
    reg = fx_trend.regime(series)
    assert reg is not None
    assert reg.direction == "sideways"
    assert reg.since_change_pct == 0
    move = fx_trend.move_normality(series)
    assert move is not None
    assert (move.move_pct, move.percentile, move.label) == (0, Decimal("0.5"), "normal")
    pct = fx_trend.rate_percentiles(series, rate, {"all": _day(0)})
    assert pct["all"] == 0  # never cheaper than an identical rate


@settings(max_examples=25, deadline=None)
@given(_steps, st.integers(min_value=-3, max_value=3))
def test_regime_invariant_under_scaling(steps: list[int], power: int) -> None:
    """Scaling every rate by 10^n scales inverse and MA alike: same regime.

    (Powers of ten keep the Decimal digits identical, so the check is exact.)
    """
    series = _walk(steps)
    k = Decimal(10) ** power
    scaled = [(d, r * k) for d, r in series]
    a, b = fx_trend.regime(series), fx_trend.regime(scaled)
    assert a is not None
    assert b is not None
    assert (a.direction, a.since, a.vs_ma200) == (b.direction, b.since, b.vs_ma200)
    assert a.since_change_pct == b.since_change_pct


@settings(max_examples=40, deadline=None)
@given(_steps, st.decimals("0.3", "3", places=4))
def test_percentiles_are_fractions(steps: list[int], today: Decimal) -> None:
    series = _walk(steps)
    windows = {"a": _day(0), "b": _day(100), "c": _day(len(steps) - 1)}
    for value in fx_trend.rate_percentiles(series, today, windows).values():
        assert value is not None
        assert 0 <= value <= 1
    move = fx_trend.move_normality(series)
    assert move is not None
    assert 0 <= move.percentile <= 1
    assert move.typical_move_pct >= 0
