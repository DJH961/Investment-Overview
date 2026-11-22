# ruff: noqa: PT018
"""Tests for ``domain.conversion_fees`` (hidden and stated conversion fees)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from investment_dashboard.domain.conversion_fees import with_hidden_fee, with_stated_fee

D = Decimal


def test_hidden_fee_golden() -> None:
    # 200.00 EUR total, 215.73 USD at the quoted 1.08465: 215.73 / 1.08465 = 198.8937...
    # fee = 200.00 - 198.8937 = 1.1063 -> 1.11; eur_sent = 198.89; all-in stays 200.00.
    legs = with_hidden_fee(eur_total=D("200.00"), usd=D("215.73"), rate=D("1.08465"))
    assert legs.fees_eur == D("1.11")
    assert legs.eur_sent == D("198.89")
    assert legs.eur_total == D("200.00")
    assert legs.usd_received == D("215.73")


def test_stated_fee_golden() -> None:
    # Send-with-conversion: debit 300.00 EUR incl. fee 2.34; (300 - 2.34) * 1.172 = 348.86.
    legs = with_stated_fee(eur_total=D("300"), fee_eur=D("2.34"), usd=D("348.86"))
    assert legs.eur_sent == D("297.66") and legs.fees_eur == D("2.34")
    assert (legs.eur_sent * D("1.172")).quantize(D("0.01")) == D("348.86")


def test_no_hidden_fee_when_rate_matches() -> None:
    legs = with_hidden_fee(eur_total=D("100"), usd=D("108.00"), rate=D("1.08"))
    assert legs.fees_eur == 0 and legs.eur_sent == D("100")


def test_rate_must_be_positive() -> None:
    with pytest.raises(ValueError, match="positive"):
        with_hidden_fee(eur_total=D("1"), usd=D("1"), rate=D("0"))


_money = st.decimals(min_value=D("0.01"), max_value=D("100000"), places=2)
_rate = st.decimals(min_value=D("0.5"), max_value=D("2"), places=5)


@settings(max_examples=200, deadline=None)
@given(_money, _money, _rate)
def test_all_in_total_is_conserved(total: Decimal, usd: Decimal, rate: Decimal) -> None:
    legs = with_hidden_fee(eur_total=total, usd=usd, rate=rate)
    assert legs.eur_sent + legs.fees_eur == total
    assert 0 <= legs.fees_eur <= total


@settings(max_examples=200, deadline=None)
@given(_money, _money)
def test_stated_fee_conserves(total: Decimal, fee: Decimal) -> None:
    legs = with_stated_fee(eur_total=total, fee_eur=fee, usd=D("1"))
    assert legs.eur_sent + legs.fees_eur == total
