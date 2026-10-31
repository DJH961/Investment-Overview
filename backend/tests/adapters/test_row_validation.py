"""Tests for light per-row consistency checks (audit D4)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from investment_dashboard.adapters.importer_types import ParsedTransactionRow
from investment_dashboard.adapters.row_validation import validate_row


def _row(**kw: object) -> ParsedTransactionRow:
    base: dict[str, object] = {
        "date": date(2024, 1, 5),
        "settlement_date": None,
        "kind": "buy",
        "symbol": "VTI",
        "quantity": Decimal("5"),
        "price_native": Decimal("100"),
        "gross_native": Decimal("500"),
        "fees_native": None,
        "net_native": Decimal("-500"),
        "description": None,
        "external_id": "x",
        "source": "import_fidelity_csv",
    }
    base.update(kw)
    return ParsedTransactionRow(**base)  # type: ignore[arg-type]


def test_clean_buy_has_no_warnings() -> None:
    assert validate_row(_row()) == []


def test_negative_price_warns() -> None:
    warnings = validate_row(_row(price_native=Decimal("-100"), gross_native=None))
    assert any("negative price" in w for w in warnings)


def test_amount_not_reconciling_warns() -> None:
    # 5 × 100 = 500, but the booked amount is far off.
    warnings = validate_row(_row(net_native=Decimal("-900")))
    assert any("reconcile" in w for w in warnings)


def test_reconciliation_tolerates_fees() -> None:
    # 5 × 100 = 500 plus a $10 commission ⇒ -510 still reconciles.
    assert validate_row(_row(net_native=Decimal("-510"), fees_native=Decimal("10"))) == []


def test_zero_quantity_trade_warns() -> None:
    warnings = validate_row(_row(quantity=Decimal("0"), gross_native=None))
    assert any("zero quantity" in w for w in warnings)


def test_dividend_cash_not_reconciled() -> None:
    # A cash dividend has no quantity×price identity to honour.
    row = _row(kind="dividend_cash", quantity=None, price_native=None, net_native=Decimal("12.34"))
    assert validate_row(row) == []
