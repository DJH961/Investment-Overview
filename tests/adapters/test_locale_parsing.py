"""Tests for US-locale numeric/date parsing (audit D5)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from investment_dashboard.adapters.locale_parsing import (
    LocaleError,
    parse_us_date,
    parse_us_decimal,
)


class TestDecimal:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("1234.56", Decimal("1234.56")),
            ("$1,234.56", Decimal("1234.56")),
            ("-$10,000.0000", Decimal("-10000.0000")),
            ("1,234,567.89", Decimal("1234567.89")),
            ("1,234", Decimal("1234")),  # US thousands separator
            ("100", Decimal("100")),
            ("-5", Decimal("-5")),
        ],
    )
    def test_us_values(self, text: str, expected: Decimal) -> None:
        assert parse_us_decimal(text) == expected

    @pytest.mark.parametrize("text", [None, "", "  ", "-", "--", "Free", "free"])
    def test_blanks_to_none(self, text: str | None) -> None:
        assert parse_us_decimal(text) is None

    @pytest.mark.parametrize(
        "text",
        [
            "1,50",  # EU decimal — US would write 1.50
            "12,5",
            "1.234,56",  # EU with both separators
            "-1.000,00",
        ],
    )
    def test_eu_locale_raises(self, text: str) -> None:
        with pytest.raises(LocaleError):
            parse_us_decimal(text)

    def test_garbage_raises_value_error(self) -> None:
        with pytest.raises(ValueError, match="Bad decimal"):
            parse_us_decimal("12x3")


class TestDate:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("01/05/2024", date(2024, 1, 5)),
            ("12/31/2024", date(2024, 12, 31)),
            ("2024-03-15", date(2024, 3, 15)),
            ("1/5/24", date(2024, 1, 5)),
        ],
    )
    def test_us_and_iso(self, text: str, expected: date) -> None:
        assert parse_us_date(text) == expected

    @pytest.mark.parametrize("text", ["13/06/2024", "31/01/2024", "25/12/2024"])
    def test_eu_dd_mm_raises(self, text: str) -> None:
        with pytest.raises(LocaleError):
            parse_us_date(text)

    def test_unrecognised_raises_value_error(self) -> None:
        with pytest.raises(ValueError, match="Unrecognised date"):
            parse_us_date("not-a-date")
