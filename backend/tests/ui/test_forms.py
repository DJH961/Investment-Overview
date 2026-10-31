"""Tests for :mod:`investment_dashboard.ui.forms` inline validators (E4)."""

from __future__ import annotations

from datetime import date

from investment_dashboard.ui.forms import (
    validate_date,
    validate_decimal,
    validate_symbol,
)

TODAY = date(2026, 6, 21)


class TestValidateDate:
    def test_accepts_valid_past_date(self) -> None:
        assert validate_date("2024-01-05", today=TODAY) is None

    def test_blank_is_required_error(self) -> None:
        assert validate_date("", today=TODAY) == "Date is required"

    def test_malformed_is_rejected(self) -> None:
        assert validate_date("05/01/2024", today=TODAY) == "Use YYYY-MM-DD"

    def test_future_date_rejected(self) -> None:
        assert validate_date("2099-01-01", today=TODAY) == "Date can't be in the future"

    def test_ancient_date_rejected(self) -> None:
        assert "too old" in (validate_date("1850-01-01", today=TODAY) or "")


class TestValidateDecimal:
    def test_blank_optional_ok(self) -> None:
        assert validate_decimal("") is None

    def test_blank_required_error(self) -> None:
        assert validate_decimal("", field="Net", required=True) == "Net is required"

    def test_non_numeric_rejected(self) -> None:
        assert validate_decimal("abc", field="Price") == "Price must be a number"

    def test_negative_blocked_when_disallowed(self) -> None:
        assert validate_decimal("-3", field="Price", allow_negative=False) == (
            "Price can't be negative"
        )

    def test_negative_allowed_by_default(self) -> None:
        assert validate_decimal("-3", field="Net") is None

    def test_zero_blocked_when_disallowed(self) -> None:
        assert validate_decimal("0", field="Qty", allow_zero=False) == "Qty can't be zero"


class TestValidateSymbol:
    def test_required_for_buy(self) -> None:
        assert validate_symbol("", kind="buy") == "Symbol is required for this kind"

    def test_valid_symbol_for_buy(self) -> None:
        assert validate_symbol("VTI", kind="buy") is None
        assert validate_symbol("EXS1.DE", kind="buy") is None

    def test_cash_kind_rejects_symbol(self) -> None:
        assert validate_symbol("VTI", kind="deposit") == "Cash transactions don't take a symbol"

    def test_cash_kind_blank_ok(self) -> None:
        assert validate_symbol("", kind="transfer_in") is None

    def test_invalid_characters_rejected(self) -> None:
        assert validate_symbol("VT I!", kind="buy") == "Symbol contains invalid characters"
