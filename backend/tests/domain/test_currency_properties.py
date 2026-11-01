"""Property + golden tests for ``domain.currency`` (money maths)."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal, localcontext

import pytest
from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.domain.currency import (
    dual_currency_amounts,
    eur_to_native,
    lookup_rate_with_forward_fill,
    native_to_eur,
    split_native_to_dual_legs,
)

amounts = st.decimals(min_value=Decimal("-1e9"), max_value=Decimal("1e9"), places=2)
rates = st.decimals(min_value=Decimal("0.1"), max_value=Decimal(10), places=4)


def test_golden_conversions() -> None:
    assert native_to_eur(Decimal("108.5"), Decimal("1.085")) == Decimal(100)
    assert eur_to_native(Decimal(100), Decimal("1.085")) == Decimal("108.500")


@pytest.mark.parametrize("bad", [Decimal(0), Decimal(-1)])
def test_non_positive_rate_rejected(bad: Decimal) -> None:
    with pytest.raises(ValueError, match="positive"):
        native_to_eur(Decimal(1), bad)
    with pytest.raises(ValueError, match="positive"):
        eur_to_native(Decimal(1), bad)


@given(amounts, rates)
def test_round_trip(amount: Decimal, rate: Decimal) -> None:
    with localcontext() as ctx:
        ctx.prec = 40
        back = eur_to_native(native_to_eur(amount, rate), rate)
        assert abs(back - amount) <= Decimal("1e-20")


@given(amounts, rates)
def test_sign_preserved(amount: Decimal, rate: Decimal) -> None:
    eur = native_to_eur(amount, rate)
    assert (eur > 0) == (amount > 0)
    assert (eur < 0) == (amount < 0)


_dates = st.dates(min_value=date(2000, 1, 1), max_value=date(2030, 1, 1))


@given(st.dictionaries(_dates, rates, max_size=15), _dates)
def test_forward_fill_uses_latest_prior(table: dict[date, Decimal], target: date) -> None:
    got = lookup_rate_with_forward_fill(table, target)
    prior = [d for d in table if d <= target]
    if not prior:
        assert got is None
    else:
        assert got == table[max(prior)]


def test_forward_fill_weekend_golden() -> None:
    fri = date(2024, 5, 3)
    table = {fri: Decimal("1.08"), fri - timedelta(days=1): Decimal("1.07")}
    assert lookup_rate_with_forward_fill(table, date(2024, 5, 5)) == Decimal("1.08")
    assert lookup_rate_with_forward_fill(table, date(2024, 4, 1)) is None


@given(amounts, rates)
def test_split_usd_native_exact_leg(amount: Decimal, rate: Decimal) -> None:
    eur, usd = split_native_to_dual_legs(
        native_currency="USD", net_native=amount, eur_to_usd_rate=rate
    )
    assert usd == amount
    assert eur == amount / rate


@given(amounts, rates)
def test_split_eur_native_exact_leg(amount: Decimal, rate: Decimal) -> None:
    eur, usd = split_native_to_dual_legs(
        native_currency="EUR", net_native=amount, eur_to_usd_rate=rate
    )
    assert eur == amount
    assert usd == amount * rate


def test_split_golden_and_missing() -> None:
    assert split_native_to_dual_legs(
        native_currency="USD", net_native=Decimal(110), eur_to_usd_rate=Decimal("1.1")
    ) == (Decimal(100), Decimal(110))
    assert split_native_to_dual_legs(
        native_currency="GBP",
        net_native=Decimal(85),
        eur_to_usd_rate=Decimal("1.1"),
        native_to_eur_rate=Decimal("0.85"),
    ) == (Decimal(100), Decimal("110.0"))
    assert split_native_to_dual_legs(
        native_currency="USD", net_native=None, eur_to_usd_rate=Decimal(1)
    ) == (None, None)
    assert split_native_to_dual_legs(
        native_currency="USD", net_native=Decimal(5), eur_to_usd_rate=None
    ) == (None, Decimal(5))


@given(amounts, amounts, rates)
def test_dual_frozen_legs_returned_verbatim(eur: Decimal, usd: Decimal, rate: Decimal) -> None:
    got = dual_currency_amounts(
        native_currency="USD",
        net_native=usd,
        net_eur=eur,
        net_usd=usd,
        on=date(2024, 1, 2),
        eur_to_usd={date(2024, 1, 2): rate},
    )
    assert got == (eur, usd)


def test_dual_uses_trade_date_rate_not_fallback() -> None:
    on = date(2024, 1, 6)  # Saturday -> Friday's rate
    got = dual_currency_amounts(
        native_currency="USD",
        net_native=Decimal(110),
        net_eur=None,
        on=on,
        eur_to_usd={date(2024, 1, 5): Decimal("1.1")},
        fallback_rate=Decimal(2),
    )
    assert got == (Decimal(100), Decimal(110))
    eur_native = dual_currency_amounts(
        native_currency="EUR",
        net_native=Decimal(100),
        net_eur=None,
        on=on,
        eur_to_usd={},
        fallback_rate=Decimal("1.2"),
    )
    assert eur_native == (Decimal(100), Decimal("120.0"))
