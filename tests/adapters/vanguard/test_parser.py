"""Vanguard parser test — sweep handling, sign conventions, sample CSV."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from investment_dashboard.adapters.importer_types import UnknownActionError
from investment_dashboard.adapters.vanguard.action_map import map_transaction_type
from investment_dashboard.adapters.vanguard.parser import parse_vanguard_csv

FIXTURE = Path(__file__).parents[1] / "fixtures" / "vanguard_sample.csv"


@pytest.mark.parametrize(
    ("txn_type", "expected"),
    [
        ("Buy", "buy"),
        ("Sell", "sell"),
        ("Reinvestment", "dividend_reinvest"),
        ("Dividend", "dividend_cash"),
        ("Funds Received", "deposit"),
        ("Funds Withdrawn", "withdrawal"),
        ("Fee", "fee"),
    ],
)
def test_map_known(txn_type: str, expected: str) -> None:
    assert map_transaction_type(txn_type) == expected


def test_sweep_maps_to_none() -> None:
    assert map_transaction_type("Sweep In") is None
    assert map_transaction_type("Sweep Out") is None


def test_unknown_raises() -> None:
    with pytest.raises(UnknownActionError):
        map_transaction_type("Some Weird New Type")


class TestParser:
    def test_drops_sweeps(self) -> None:
        result = parse_vanguard_csv(FIXTURE.read_text())
        assert result.sweeps_dropped == 2

    def test_parsed_buy(self) -> None:
        result = parse_vanguard_csv(FIXTURE.read_text())
        buy = next(r for r in result.rows if r.kind == "buy")
        assert buy.date == date(2024, 1, 5)
        assert buy.symbol == "VTI"
        assert buy.quantity == Decimal("5")
        assert buy.net_native == Decimal("-1100.00")

    def test_parsed_sell_quantity_negated(self) -> None:
        result = parse_vanguard_csv(FIXTURE.read_text())
        sell = next(r for r in result.rows if r.kind == "sell")
        assert sell.quantity == Decimal("-2")
        assert sell.net_native == Decimal("450.00")

    def test_deposit_no_symbol(self) -> None:
        result = parse_vanguard_csv(FIXTURE.read_text())
        dep = next(r for r in result.rows if r.kind == "deposit")
        assert dep.symbol is None
        assert dep.net_native == Decimal("2000.00")

    def test_external_ids_unique(self) -> None:
        result = parse_vanguard_csv(FIXTURE.read_text())
        ids = [r.external_id for r in result.rows]
        assert len(set(ids)) == len(ids)
