"""Fidelity action-map tests."""

from __future__ import annotations

import pytest

from investment_dashboard.adapters.fidelity.action_map import map_action
from investment_dashboard.adapters.importer_types import UnknownActionError


@pytest.mark.parametrize(
    ("action", "expected"),
    [
        ("YOU BOUGHT VANGUARD TOTAL STOCK MARKET ETF", "buy"),
        ("YOU SOLD VTI", "sell"),
        ("REINVESTMENT VTI", "dividend_reinvest"),
        ("DIVIDEND RECEIVED VTI", "dividend_cash"),
        ("INTEREST EARNED", "interest"),
        ("ELECTRONIC FUNDS TRANSFER RECEIVED", "deposit"),
        ("EFT FUNDS PAID", "withdrawal"),
        ("FOREIGN TAX PAID", "fee"),
    ],
)
def test_map_action_known(action: str, expected: str) -> None:
    assert map_action(action) == expected


def test_map_action_case_insensitive() -> None:
    assert map_action("you bought something") == "buy"


def test_unknown_raises() -> None:
    with pytest.raises(UnknownActionError):
        map_action("MERGER NOTIFICATION FOOBAR")
