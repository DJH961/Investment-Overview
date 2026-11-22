"""Golden + property tests for ``domain.fx_scenarios`` (the "What if" rows, v7.2).

Hand-made books and rates; each golden value is worked out next to its assertion.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain import fx_scenarios as fs
from investment_dashboard.domain.late_data import Holding, value_at_rate

BOOK = fs.Book(usd=Decimal(1000), eur=Decimal(500))


def test_value_at_golden() -> None:
    # EUR: 500 + 1000 / 1.25 = 1300 ; USD: 1000 + 500 * 1.25 = 1625
    assert fs.value_at(BOOK, Decimal("1.25"), "EUR") == 1300
    assert fs.value_at(BOOK, Decimal("1.25"), "USD") == 1625


def test_gain_at_golden() -> None:
    # EUR: the dollars at 1.25 minus at the 1.00 average: 800 - 1000 = -200
    assert fs.gain_at(BOOK, Decimal("1.25"), Decimal("1.00"), "EUR") == -200
    # USD: the euros at 1.25 minus at 1.00: 625 - 500 = 125
    assert fs.gain_at(BOOK, Decimal("1.25"), Decimal("1.00"), "USD") == 125
    # break-even: zero at the average itself
    assert fs.gain_at(BOOK, Decimal("1.10"), Decimal("1.10"), "EUR") == 0


def test_scenario_golden_table() -> None:
    """A $10,000 book bought at an average of 1.25, valued on the 0.90..1.60 slider."""
    book = fs.Book(usd=Decimal(10000), eur=Decimal(0))
    avg = Decimal("1.25")
    rates = fs.slider_rates()
    assert len(rates) == 141
    assert rates[0] == Decimal("0.90")
    assert rates[-1] == Decimal("1.60")
    assert rates[1] - rates[0] == Decimal("0.005")
    # 1.00: €10,000, gain 10,000 - 8,000 = +€2,000
    i = rates.index(Decimal("1.00"))
    assert fs.value_at(book, rates[i], "EUR") == 10000
    assert fs.gain_at(book, rates[i], avg, "EUR") == 2000
    # 1.25: €8,000, gain 0 (break-even)
    j = rates.index(Decimal("1.25"))
    assert fs.value_at(book, rates[j], "EUR") == 8000
    assert fs.gain_at(book, rates[j], avg, "EUR") == 0
    # 1.60: €6,250, gain 6,250 - 8,000 = -€1,750
    assert fs.value_at(book, rates[-1], "EUR") == 6250
    assert fs.gain_at(book, rates[-1], avg, "EUR") == -1750
    # USD view: dollars do not move with the rate; no EUR holdings, so no gain
    assert fs.value_at(book, rates[-1], "USD") == 10000
    assert fs.gain_at(book, rates[-1], avg, "USD") == 0


def test_stress_and_one_cent_golden() -> None:
    assert fs.stress_rates(Decimal("1.20")) == [
        Decimal("1.0200"),
        Decimal("1.0800"),
        Decimal("1.1400"),
        Decimal("1.2600"),
        Decimal("1.3200"),
        Decimal("1.3800"),
    ]
    book = fs.Book(usd=Decimal(10000), eur=Decimal(0))
    # One cent from 1.25: 10000 / 1.26 - 10000 / 1.25 = 7936.507936... - 8000 = -63.49...
    change = fs.value_at(book, Decimal("1.26"), "EUR") - fs.value_at(book, Decimal("1.25"), "EUR")
    assert change.quantize(Decimal("0.01")) == Decimal("-63.49")


def test_nearest_index() -> None:
    rates = [Decimal("1.0"), Decimal("1.1"), Decimal("1.2")]
    assert fs.nearest_index(rates, Decimal("1.04")) == 0
    assert fs.nearest_index(rates, Decimal("1.15")) == 1  # tie -> the lower row
    assert fs.nearest_index(rates, Decimal("9")) == 2
    with pytest.raises(ValueError, match="no rates"):
        fs.nearest_index([], Decimal(1))


def test_book_from_holdings_matches_value_at_rate_convention() -> None:
    holdings = [
        Holding("USD", Decimal(1000), Decimal(900)),
        Holding("EUR", Decimal(500), Decimal(500)),
        Holding("GBP", Decimal(100), Decimal(120)),  # other: its EUR mark
    ]
    book = fs.book_from_holdings(holdings)
    assert book == fs.Book(usd=Decimal(1000), eur=Decimal(620))
    eur, usd = value_at_rate(holdings, Decimal("1.25"))
    assert fs.value_at(book, Decimal("1.25"), "EUR") == eur
    assert fs.value_at(book, Decimal("1.25"), "USD") == usd


def test_weekday_returns_and_down_days_golden() -> None:
    fri = date(2026, 1, 2)  # a Friday
    sat, mon, tue, wed = (fri + timedelta(days=n) for n in (1, 3, 4, 5))
    points = [
        (fri, Decimal(100)),
        (sat, Decimal(100)),
        (mon, Decimal(110)),
        (tue, Decimal(99)),
        (wed, Decimal("98.01")),
    ]
    rets = fs.weekday_returns(points)
    # Mon vs Fri +10 %, Tue vs Mon -10 %, Wed vs Tue -1 %
    assert rets == [(mon, Decimal("0.1")), (tue, Decimal("-0.1")), (wed, Decimal("-0.01"))]
    rates = {fri: Decimal("1.20"), mon: Decimal("1.21"), tue: Decimal("1.19")}
    # Tue: down, rate 1.19 < Mon 1.21 -> the dollar rose. Wed: no fixing -> not counted.
    down = fs.dollar_on_down_days(rets, rates)
    assert down == fs.DownDays(down_days=1, dollar_rose=1)
    assert down.share == 1
    assert fs.DownDays(0, 0).share is None


def test_bad_rates_rejected() -> None:
    with pytest.raises(ValueError, match="rate must be positive"):
        fs.value_at(BOOK, Decimal(0), "EUR")
    with pytest.raises(ValueError, match="rate must be positive"):
        fs.gain_at(BOOK, Decimal(1), Decimal(0), "EUR")
    with pytest.raises(ValueError, match="need 0 < lo <= hi and step > 0"):
        fs.slider_rates(Decimal(1), Decimal("0.5"))


# --- properties ----------------------------------------------------------------

_money = st.decimals("0", "1000000", places=2)
_rate = st.decimals("0.5", "2", places=4)


@settings(max_examples=60, deadline=None)
@given(_money, _money, _rate)
def test_value_matches_late_data_value_at_rate(usd: Decimal, eur: Decimal, rate: Decimal) -> None:
    holdings = [Holding("USD", usd, Decimal(0)), Holding("EUR", eur, eur)]
    v_eur, v_usd = value_at_rate(holdings, rate)
    book = fs.book_from_holdings(holdings)
    assert fs.value_at(book, rate, "EUR") == v_eur
    assert fs.value_at(book, rate, "USD") == v_usd


@settings(max_examples=60, deadline=None)
@given(_money, _money, _rate, _rate)
def test_gain_is_zero_at_average_and_monotone(
    usd: Decimal, eur: Decimal, rate: Decimal, avg: Decimal
) -> None:
    book = fs.Book(usd=usd, eur=eur)
    assert fs.gain_at(book, avg, avg, "EUR") == 0
    assert fs.gain_at(book, avg, avg, "USD") == 0
    higher = rate + Decimal("0.01")
    # A stronger euro never raises the EUR value of dollars, never lowers the USD value of euros.
    assert fs.gain_at(book, higher, avg, "EUR") <= fs.gain_at(book, rate, avg, "EUR")
    assert fs.gain_at(book, higher, avg, "USD") >= fs.gain_at(book, rate, avg, "USD")


@settings(max_examples=60, deadline=None)
@given(_money, _rate, _rate)
def test_pure_dollar_eur_gain_is_the_lifetime_formula(
    usd: Decimal, rate: Decimal, avg: Decimal
) -> None:
    """For a dollar-only book the EUR gain is ``value_eur - value_usd / avg`` (fx_pnl_eur)."""
    book = fs.Book(usd=usd, eur=Decimal(0))
    value_eur = fs.value_at(book, rate, "EUR")
    value_usd = fs.value_at(book, rate, "USD")
    assert abs(fs.gain_at(book, rate, avg, "EUR") - (value_eur - value_usd / avg)) < Decimal(
        "1e-18"
    )


@settings(max_examples=40, deadline=None)
@given(_money, _money, _rate)
def test_usd_value_never_moves_for_a_dollar_book(usd: Decimal, eur: Decimal, rate: Decimal) -> None:
    """USD view: dollars stay dollars at every rate (USD is never derived from EUR)."""
    book = fs.Book(usd=usd, eur=Decimal(0))
    assert fs.value_at(book, rate, "USD") == usd
    assert fs.value_at(book, rate + Decimal("0.1"), "USD") == usd
