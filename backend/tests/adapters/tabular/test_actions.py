"""``classify_action``: multi-language free text -> ledger kind."""

from __future__ import annotations

import pytest

from investment_dashboard.adapters.importer_types import UnknownActionError
from investment_dashboard.adapters.tabular.actions import classify_action, known_action_share


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        # English
        ("Buy", "buy"),
        ("YOU BOUGHT VANGUARD TOTAL STOCK MARKET ETF", "buy"),
        ("Sell", "sell"),
        ("YOU SOLD VTI", "sell"),
        ("Dividend", "dividend_cash"),
        ("Dividend Received", "dividend_cash"),
        ("Reinvestment", "dividend_reinvest"),
        ("Dividend reinvestment", "dividend_reinvest"),
        ("Interest", "interest"),
        ("Deposit", "deposit"),
        ("Funds Received", "deposit"),
        ("Withdrawal", "withdrawal"),
        ("Fee", "fee"),
        ("Foreign tax paid", "fee"),
        ("Tax", "fee"),
        ("Stock split", "split"),
        ("Sweep in", None),
        ("Sweep Out", None),
        # German
        ("Kauf", "buy"),
        ("Verkauf", "sell"),
        ("Ausschüttung", "dividend_cash"),
        ("Dividende", "dividend_cash"),
        ("Zinsen", "interest"),
        ("Einzahlung", "deposit"),
        ("Auszahlung", "withdrawal"),
        ("Gebühr", "fee"),
        ("Quellensteuer", "fee"),
        ("Wiederanlage", "dividend_reinvest"),
        # French
        ("Achat", "buy"),
        ("Vente", "sell"),
        ("Versement", "deposit"),
        ("Retrait", "withdrawal"),
        ("Frais", "fee"),
        # Spanish
        ("Compra", "buy"),
        ("Venta", "sell"),
        ("Dividendo", "dividend_cash"),
        ("Retiro", "withdrawal"),
        # Dutch
        ("Aankoop", "buy"),
        ("Verkoop", "sell"),
        ("Storting", "deposit"),
    ],
)
def test_classify(text: str, kind: str | None) -> None:
    assert classify_action(text) == kind


def test_verkauf_is_sell_not_buy() -> None:
    # "Verkauf" contains "kauf": the sell rule must win.
    assert classify_action("Verkauf") == "sell"
    assert classify_action("VERKAUF Fonds") == "sell"


def test_whitespace_and_case_insensitive() -> None:
    assert classify_action("  bUy   of   VTI ") == "buy"


def test_overrides_win() -> None:
    assert classify_action("Buy", {"Buy": "deposit"}) == "deposit"
    assert classify_action("weird thing", {"weird thing": "interest"}) == "interest"


def test_override_ignore_drops_row() -> None:
    assert classify_action("Dividend", {"dividend": "ignore"}) is None


def test_unknown_raises() -> None:
    with pytest.raises(UnknownActionError):
        classify_action("Gobbledygook")


def test_known_action_share() -> None:
    assert known_action_share([]) == 0.0
    assert known_action_share(["Buy", "Sell", "xyzzy", ""]) == pytest.approx(2 / 3)
