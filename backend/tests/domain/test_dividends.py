"""Dividend-income recognition unit tests (domain/dividends.py).

Locks in the "assume reinvestment, but be robust to the early cash-dividend
period" behaviour: reinvested distributions are valued at quantity×price and
their paired cash leg is skipped, while a cash dividend with no paired reinvest
is still recognised as income.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, cast

from investment_dashboard.domain import dividends
from investment_dashboard.models import Transaction


def _txn(
    *,
    kind: str,
    account_id: int = 1,
    instrument_id: int | None = 10,
    on: date = date(2024, 1, 5),
    quantity: Decimal | None = None,
    price_native: Decimal | None = None,
    net_native: Decimal | None = None,
    net_eur: Decimal | None = None,
    net_usd: Decimal | None = None,
    native_currency: str = "USD",
) -> Transaction:
    ns = SimpleNamespace(
        kind=kind,
        account_id=account_id,
        instrument_id=instrument_id,
        date=on,
        quantity=quantity,
        price_native=price_native,
        net_native=net_native,
        net_eur=net_eur,
        net_usd=net_usd,
        account=SimpleNamespace(native_currency=native_currency),
    )
    return cast("Transaction", cast("Any", ns))


def test_reinvested_dividend_uses_quantity_times_price() -> None:
    reinvest = _txn(
        kind="dividend_reinvest",
        quantity=Decimal("2"),
        price_native=Decimal("50"),
        net_native=Decimal("0"),
    )
    keys = dividends.reinvest_keys([reinvest])
    assert dividends.income_value_native(reinvest, keys) == Decimal("100")


def test_paired_cash_leg_is_skipped() -> None:
    reinvest = _txn(kind="dividend_reinvest", quantity=Decimal("2"), price_native=Decimal("50"))
    cash = _txn(kind="dividend_cash", net_native=Decimal("100"))
    keys = dividends.reinvest_keys([reinvest, cash])
    # The cash leg of a reinvested dividend must not be double-counted.
    assert dividends.income_value_native(cash, keys) is None


def test_unpaired_cash_dividend_counts_as_income() -> None:
    # Early period: a genuine cash dividend with no reinvest leg.
    cash = _txn(kind="dividend_cash", net_native=Decimal("12.34"))
    keys = dividends.reinvest_keys([cash])
    assert dividends.income_value_native(cash, keys) == Decimal("12.34")


def test_realized_cash_excludes_reinvested_but_keeps_unpaired_cash() -> None:
    reinvest = _txn(
        kind="dividend_reinvest",
        instrument_id=10,
        quantity=Decimal("2"),
        price_native=Decimal("50"),
    )
    unpaired_cash = _txn(kind="dividend_cash", instrument_id=20, net_native=Decimal("12.34"))
    keys = dividends.reinvest_keys([reinvest, unpaired_cash])
    # include_reinvested=False ⇒ only realized (un-reinvested) cash.
    assert dividends.income_value_native(reinvest, keys, include_reinvested=False) is None
    assert dividends.income_value_native(unpaired_cash, keys, include_reinvested=False) == Decimal(
        "12.34"
    )


def test_income_dual_unpaired_cash_uses_frozen_legs() -> None:
    cash = _txn(
        kind="dividend_cash",
        net_native=Decimal("100"),
        net_eur=Decimal("80"),
        net_usd=Decimal("100"),
    )
    keys = dividends.reinvest_keys([cash])
    eur, usd = dividends.income_dual(cash, keys, eur_to_usd={})
    assert eur == Decimal("80")
    assert usd == Decimal("100")
