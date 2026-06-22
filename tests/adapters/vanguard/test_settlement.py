"""Unit tests for synthesized Vanguard VMFXX settlement legs.

``settlement.inject_settlement_legs`` encodes the load-bearing signed-leg
conventions for the auto-reconstructed money-market holding: a cash *inflow*
buys VMFXX shares, a cash *outflow* sells them, each priced at the constant
$1.00 NAV, and VMFXX's own dividends compound into reinvested shares. These
tests pin those conventions directly rather than only through the importer.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from investment_dashboard.adapters.importer_types import ParsedTransactionRow
from investment_dashboard.adapters.vanguard import settlement
from investment_dashboard.domain.money_market import MONEY_MARKET_ASSET_CLASS


def _row(**overrides: object) -> ParsedTransactionRow:
    base = dict(
        date=date(2025, 1, 2),
        settlement_date=date(2025, 1, 3),
        kind="buy",
        symbol="VOO",
        quantity=Decimal("1"),
        price_native=Decimal("100"),
        gross_native=None,
        fees_native=None,
        net_native=Decimal("-100"),
        description="Buy",
        external_id="src-1",
        source="vanguard",
    )
    base.update(overrides)
    return ParsedTransactionRow(**base)  # type: ignore[arg-type]


def _legs(rows: list[ParsedTransactionRow]) -> list[ParsedTransactionRow]:
    return [r for r in rows if r.symbol == settlement.SETTLEMENT_SYMBOL]


def test_cash_outflow_sells_settlement_shares() -> None:
    # A security purchase moves cash OUT (net_native -100) -> sell VMFXX.
    out = settlement.inject_settlement_legs([_row(net_native=Decimal("-100"))])
    legs = _legs(out)
    assert len(legs) == 1
    leg = legs[0]
    assert leg.kind == "sell"
    assert leg.quantity == Decimal("-100")  # shares sold are negative
    assert leg.net_native == Decimal("100")  # opposite sign of the source
    assert leg.price_native == settlement.NAV == Decimal("1")
    assert leg.asset_class == MONEY_MARKET_ASSET_CLASS
    assert leg.external_id == "src-1:vmfxx"
    assert leg.native_currency == "USD"


def test_cash_inflow_buys_settlement_shares() -> None:
    # A deposit / sale proceeds move cash IN (net_native +250) -> buy VMFXX.
    out = settlement.inject_settlement_legs(
        [_row(kind="deposit", symbol=None, net_native=Decimal("250"))]
    )
    legs = _legs(out)
    assert len(legs) == 1
    leg = legs[0]
    assert leg.kind == "buy"
    assert leg.quantity == Decimal("250")
    assert leg.net_native == Decimal("-250")


def test_zero_or_missing_net_adds_no_leg() -> None:
    out = settlement.inject_settlement_legs(
        [_row(net_native=Decimal("0")), _row(external_id="src-2", net_native=None)]
    )
    assert _legs(out) == []
    assert len(out) == 2  # the original rows survive untouched


def test_settlement_dividend_cash_becomes_reinvestment() -> None:
    div = _row(
        kind="dividend_cash",
        symbol="VMFXX",
        quantity=None,
        price_native=None,
        net_native=Decimal("3.25"),
        description="Dividend",
        external_id="div-1",
    )
    out = settlement.inject_settlement_legs([div])
    assert len(out) == 1
    rewritten = out[0]
    assert rewritten.kind == "dividend_reinvest"
    assert rewritten.quantity == Decimal("3.25")  # cash compounds into shares
    assert rewritten.price_native == settlement.NAV
    assert rewritten.net_native == Decimal("0")
    assert rewritten.asset_class == MONEY_MARKET_ASSET_CLASS


def test_settlement_dividend_cash_non_positive_is_tagged_only() -> None:
    div = _row(
        kind="dividend_cash",
        symbol="VMFXX",
        quantity=None,
        net_native=Decimal("0"),
        external_id="div-0",
    )
    out = settlement.inject_settlement_legs([div])
    assert len(out) == 1
    assert out[0].kind == "dividend_cash"  # unchanged kind
    assert out[0].asset_class == MONEY_MARKET_ASSET_CLASS  # but tagged as money-market


def test_settlement_reinvestment_artifact_is_dropped() -> None:
    artifact = _row(
        kind="dividend_reinvest",
        symbol="VMFXX",
        quantity=None,
        net_native=None,
        external_id="reinv-artifact",
    )
    out = settlement.inject_settlement_legs([artifact])
    assert out == []


def test_settlement_own_trade_is_tagged_without_counter_leg() -> None:
    # A genuine VMFXX buy keeps its kind but is seeded as a money-market fund,
    # and must NOT spawn a counter-leg (that would double-count).
    own = _row(
        kind="buy",
        symbol="vmfxx",  # lower-case still recognised
        quantity=Decimal("10"),
        net_native=Decimal("-10"),
        external_id="own-1",
    )
    out = settlement.inject_settlement_legs([own])
    assert len(out) == 1
    assert out[0].asset_class == MONEY_MARKET_ASSET_CLASS
    assert out[0].name == settlement.SETTLEMENT_NAME


def test_transform_is_idempotent_on_external_ids() -> None:
    rows = [_row(net_native=Decimal("-100"))]
    once = settlement.inject_settlement_legs(rows)
    ids = [r.external_id for r in once]
    assert len(set(ids)) == len(ids)
    # The synthesized id derives stably from the source row.
    assert "src-1:vmfxx" in ids
