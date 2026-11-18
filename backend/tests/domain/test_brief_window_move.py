"""Golden and property tests for the Brief's window move maths (pure domain)."""

from __future__ import annotations

from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.brief import holding_window_move, window_figures

D = Decimal


def test_deposit_inside_the_window_is_not_a_gain() -> None:
    # Start 1,000, 200 deposited, end 1,250: the book gained 50 on 1,200 at work.
    fig = window_figures(
        start_value=D("1000"), end_value=D("1250"), net_flows=D("200"), currency_move=None
    )
    assert fig.move == D("50")
    assert fig.pct == D("50") / D("1200")  # 0.041666...
    assert fig.price_move == D("50")
    assert fig.currency_move is None


def test_withdrawal_counts_negative() -> None:
    fig = window_figures(
        start_value=D("1000"), end_value=D("700"), net_flows=D("-400"), currency_move=None
    )
    # 700 - 1000 + 400 = +100 on 600 at work.
    assert fig.move == D("100")
    assert fig.pct == D("100") / D("600")


def test_euro_view_splits_market_and_currency() -> None:
    # Book 10,000 USD at 1.1600 = 8,620.689655... EUR; at 1.1650 = 8,583.690987...:
    # the rate alone cost -36.99866805 EUR (the golden figure of the currency box).
    rate_then, rate_now = D("1.1600"), D("1.1650")
    currency = D("10000") / rate_now - D("10000") / rate_then
    start = D("10000") / rate_then
    end = D("10000") / rate_now + D("120")  # and 120 EUR of market gains
    fig = window_figures(start_value=start, end_value=end, net_flows=D("0"), currency_move=currency)
    assert round(currency, 8) == D("-36.99866805")
    assert fig.move == end - start
    assert round(fig.price_move, 8) == D("120.00000000")
    assert fig.price_move + currency == fig.move


def test_usd_view_has_no_currency_leg() -> None:
    fig = window_figures(
        start_value=D("11600"), end_value=D("11700"), net_flows=D("0"), currency_move=None
    )
    assert fig.currency_move is None
    assert fig.price_move == fig.move == D("100")
    assert fig.pct == D("100") / D("11600")


def test_nothing_at_risk_has_no_percentage() -> None:
    fig = window_figures(
        start_value=D("0"), end_value=D("50"), net_flows=D("0"), currency_move=None
    )
    assert fig.pct is None
    assert fig.move == D("50")


@given(
    start=st.decimals(min_value="0", max_value="1e9", places=2),
    end=st.decimals(min_value="0", max_value="1e9", places=2),
    flows=st.decimals(min_value="-1e8", max_value="1e8", places=2),
    currency=st.one_of(st.none(), st.decimals(min_value="-1e7", max_value="1e7", places=4)),
)
def test_price_plus_currency_is_the_move(
    start: Decimal, end: Decimal, flows: Decimal, currency: Decimal | None
) -> None:
    fig = window_figures(start_value=start, end_value=end, net_flows=flows, currency_move=currency)
    assert fig.move == end - start - flows
    assert fig.price_move + (currency or D(0)) == fig.move


def test_usd_holding_in_euros_moves_with_both_prices_and_rates() -> None:
    # 10 shares 100 -> 110 USD; rate 1.16 -> 1.10: 1000/1.16 = 862.0689655...,
    # 1100/1.10 = 1000 EUR: +137.9310344... = +16.0%.
    got = holding_window_move(
        view="EUR",
        native_currency="USD",
        shares=D("10"),
        price_start=D("100"),
        price_end=D("110"),
        rate_then=D("1.16"),
        rate_now=D("1.10"),
    )
    assert got is not None
    move, pct = got
    assert round(move, 8) == D("137.93103448")
    assert round(pct, 6) == D("0.160000")


def test_usd_holding_in_dollars_needs_no_rate() -> None:
    got = holding_window_move(
        view="USD",
        native_currency="USD",
        shares=D("10"),
        price_start=D("100"),
        price_end=D("110"),
        rate_then=None,
        rate_now=None,
    )
    assert got == (D("100"), D("0.1"))


def test_missing_rate_or_odd_currency_is_skipped() -> None:
    kwargs = {
        "shares": D("1"),
        "price_start": D("10"),
        "price_end": D("11"),
        "rate_then": None,
        "rate_now": D("1.1"),
    }
    assert holding_window_move(view="EUR", native_currency="USD", **kwargs) is None
    assert holding_window_move(view="EUR", native_currency="GBP", **kwargs) is None
