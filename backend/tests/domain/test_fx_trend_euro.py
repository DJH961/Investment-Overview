"""The euro's own trend (``domain.fx_trend``, ``of="euro"``): the USD view of Exposure.

Hand-made EUR/USD series only; no real data.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from investment_dashboard.domain import fx_trend as ft

D = Decimal
DAY0 = date(2024, 1, 1)


def _series(values: list[Decimal]) -> list[tuple[date, Decimal]]:
    return [(DAY0 + timedelta(i), v) for i, v in enumerate(values)]


def _rising() -> list[tuple[date, Decimal]]:
    """220 days flat at 1.0000, then 40 days rising 0.0020 a day to 1.0800."""
    flat = [D("1.0000")] * 220
    up = [D("1.0000") + D("0.0020") * (i + 1) for i in range(40)]
    return _series(flat + up)


def test_rising_rate_is_the_euro_strengthening_and_the_dollar_weakening() -> None:
    series = _rising()
    euro = ft.regime(series, of="euro")
    dollar = ft.regime(series)
    assert euro is not None
    assert dollar is not None
    assert euro.direction == "euro_up"
    assert dollar.direction == "dollar_down"
    rates = dict(series)
    # Each one's own change since its own start, on its own price.
    assert euro.since_change_pct == D("1.0800") / rates[euro.since] - 1
    assert dollar.since_change_pct == (1 / D("1.0800")) / (1 / rates[dollar.since]) - 1
    assert euro.since_change_pct > 0 > dollar.since_change_pct
    assert euro.vs_ma200 == "above"
    assert dollar.vs_ma200 == "below"


def test_moves_are_computed_on_each_price_never_negated() -> None:
    # 1.00 -> 1.25: the euro +25 %, the dollar 1/1.25 - 1 = -20 % (not -25 %).
    series = _series([D("1.00"), D("1.25")])
    assert ft.trailing_moves(series, 1, of="euro") == [(DAY0 + timedelta(1), D("0.25"))]
    assert ft.trailing_moves(series, 1) == [(DAY0 + timedelta(1), D("-0.2"))]
    euro = ft.move_normality(series, 1, of="euro")
    dollar = ft.move_normality(series, 1)
    assert euro is not None
    assert dollar is not None
    assert euro.move_pct == D("0.25")
    assert dollar.move_pct == D("-0.2")
    band = ft.move_band(series, 1, of="euro")
    assert band is not None
    assert band.typical_move_pct == D("0.25")


def test_ma_slope_run_and_percentiles_for_the_euro() -> None:
    series = _rising()
    s = ft.ma_slope(series, of="euro")
    assert s is not None
    assert s.side == "above"
    assert s.label == "rising"
    assert s.distance_pct == D("1.0800") / s.ma_now - 1
    assert s.ma_rate_now == s.ma_now  # the euro's price is the rate itself
    # Month ends: Jan..Sep 2024; the rate rose in the last two months, flat before.
    run = ft.monthly_run(series, months=2, of="euro")
    assert run is not None
    assert run.direction == "rose"
    dollar_run = ft.monthly_run(series, months=2)
    assert dollar_run is not None
    assert dollar_run.direction == "fell"
    # Today 1.08: the euro was cheaper (a lower rate) on every other day; the dollar
    # cheaper (a higher rate) on none.
    windows = {"all": DAY0}
    euro_pct = ft.rate_percentiles(series, D("1.0800"), windows, of="euro")["all"]
    dollar_pct = ft.rate_percentiles(series, D("1.0800"), windows)["all"]
    assert euro_pct == D(259) / D(260)
    assert dollar_pct == 0
