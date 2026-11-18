"""The Daily Brief's currency effect since the last visit (``currency_effect_since``)."""

from __future__ import annotations

from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.brief import (
    CurrencyEffectSince,
    currency_effect_since,
    investing_power_since,
)
from investment_dashboard.domain.late_data import Holding, value_at_rate
from investment_dashboard.domain.session_fx import fx_buying_power_split

D = Decimal
Q = D("0.00000001")

rates = st.decimals(min_value=D("0.5"), max_value=D("2.0"), places=4)
amounts = st.decimals(min_value=D("0.01"), max_value=D("10000000"), places=2)


def _q(value: Decimal) -> Decimal:
    return value.quantize(Q)


def _sides(
    book: list[Holding], then: Decimal, now: Decimal
) -> tuple[CurrencyEffectSince, CurrencyEffectSince]:
    """``(EUR, USD)`` effects of a book with a positive value in both currencies."""
    out = currency_effect_since(book, rate_then=then, rate_now=now)
    assert out is not None
    eur, usd = out["EUR"], out["USD"]
    assert eur is not None
    assert usd is not None
    return eur, usd


def test_golden_mixed_book_worked_by_hand() -> None:
    # $10,000 + EUR 2,000; EUR/USD 1.1600 at the last visit, 1.1650 now.
    # EUR: 10000 x (1/1.165 - 1/1.16) = -50 / 1.3514 = -36.99866805 EUR; the EUR 2,000
    #      do not move. Base = 10000/1.16 + 2000 = 10620.68965517 -> -0.34836 %.
    # USD: the $10,000 contribute 0; 2000 x (1.165 - 1.16) = 10.00 USD.
    #      Base = 10000 + 2000 x 1.16 = 12320 -> 10 / 12320 = 0.08117 %.
    book = [Holding("USD", D("10000")), Holding("EUR", D("2000"))]
    eur, usd = _sides(book, D("1.1600"), D("1.1650"))
    assert _q(eur.amount) == D("-36.99866805")
    assert _q(eur.value_then) == D("10620.68965517")
    assert _q(eur.pct) == D("-0.00348364")
    assert usd.amount == D("10.0000")
    assert usd.value_then == D("12320.0000")
    assert _q(usd.pct) == D("0.00081169")


def test_unusable_rate_or_empty_book() -> None:
    book = [Holding("USD", D("100"))]
    assert currency_effect_since(book, rate_then=D(0), rate_now=D("1.1")) is None
    assert currency_effect_since(book, rate_then=D("1.1"), rate_now=D("-1")) is None
    empty = currency_effect_since([], rate_then=D("1.1"), rate_now=D("1.2"))
    assert empty == {"EUR": None, "USD": None}


@given(usd=amounts, then=rates, now=rates)
def test_usd_holdings_have_no_usd_effect(usd: Decimal, then: Decimal, now: Decimal) -> None:
    eur_side, usd_side = _sides([Holding("USD", usd)], then, now)
    assert usd_side.amount == 0
    assert usd_side.pct == 0
    # EUR: a valuation at two instants, each at its own rate.
    assert eur_side.amount == usd / now - usd / then


@given(eur=amounts, usd=amounts, then=rates, now=rates)
def test_usd_figure_is_built_from_native_euros(
    eur: Decimal, usd: Decimal, then: Decimal, now: Decimal
) -> None:
    # The USD effect only depends on the EUR-native amount, never on the USD book or
    # the EUR figure: adding dollars changes nothing in it.
    alone_eur, alone_usd = _sides([Holding("EUR", eur)], then, now)
    _mixed_eur, mixed_usd = _sides([Holding("EUR", eur), Holding("USD", usd)], then, now)
    assert alone_usd.amount == mixed_usd.amount == eur * (now - then)
    assert alone_eur.amount == 0


@given(a=amounts, b=amounts, ca=st.sampled_from(["EUR", "USD"]), then=rates, now=rates)
def test_matches_the_currency_box_revaluation(
    a: Decimal, b: Decimal, ca: str, then: Decimal, now: Decimal
) -> None:
    # Same definition as metrics_service.fx_revaluation: value_at_rate(now) - (then).
    book = [Holding(ca, a), Holding("USD", b)]
    eur, usd = _sides(book, then, now)
    eur_then, usd_then = value_at_rate(book, then)
    eur_now, usd_now = value_at_rate(book, now)
    assert eur.amount == eur_now - eur_then
    assert usd.amount == usd_now - usd_then
    assert eur.pct == eur.amount / eur_then
    assert usd.pct == usd.amount / usd_then


@given(a=amounts, b=amounts, then=rates, now=rates)
def test_additive_and_zero_without_a_move(
    a: Decimal, b: Decimal, then: Decimal, now: Decimal
) -> None:
    one = _sides([Holding("USD", a)], then, now)
    two = _sides([Holding("EUR", b)], then, now)
    both = _sides([Holding("USD", a), Holding("EUR", b)], then, now)
    for x, y, z in zip(one, two, both, strict=True):
        assert abs(z.amount - (x.amount + y.amount)) < D("1e-18")
    for side in _sides([Holding("USD", a), Holding("EUR", b)], then, then):
        assert side.amount == 0


def test_investing_power_golden_worked_by_hand() -> None:
    # EUR 100 regular amount: 100 x 1.1600 = $116.00 then, 100 x 1.1650 = $116.50 now;
    # net = +$0.50 (the euro gained, the same euros buy more dollars); 0.50 / 116 =
    # 0.431 % = 1.1650 / 1.1600 - 1.
    power = investing_power_since(D("100"), rate_then=D("1.1600"), rate_now=D("1.1650"))
    assert power is not None
    assert power.amount_eur == D("100")
    assert power.amount_usd_then == D("116.0000")
    assert power.amount_usd_now == D("116.5000")
    assert power.net == D("0.5000")
    assert _q(power.pct) == D("0.00431034")


def test_investing_power_needs_an_amount_and_rates() -> None:
    assert investing_power_since(D(0), rate_then=D("1.1"), rate_now=D("1.2")) is None
    assert investing_power_since(D("100"), rate_then=D(0), rate_now=D("1.2")) is None
    assert investing_power_since(D("100"), rate_then=D("1.1"), rate_now=D(0)) is None


@given(amount=amounts, then=rates, now=rates)
def test_investing_power_matches_the_overview_split(
    amount: Decimal, then: Decimal, now: Decimal
) -> None:
    power = investing_power_since(amount, rate_then=then, rate_now=now)
    assert power is not None
    split = fx_buying_power_split(
        market_open=False, amount_eur=amount, live_fx=now, prev_fx=then, session_close_fx=None
    )
    assert power.net == split.total_usd == amount * (now - then)
    assert power.net == power.amount_usd_now - power.amount_usd_then
    assert abs(power.pct - (now / then - 1)) < D("1e-20")
