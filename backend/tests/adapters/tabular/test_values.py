# ruff: noqa: RUF001, PT011
"""Tests for locale-tolerant number/date parsing and format inference."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from investment_dashboard.adapters.tabular.values import (
    infer_date_order,
    infer_decimal,
    looks_numeric,
    parse_date,
    parse_number,
)


class TestParseNumber:
    @pytest.mark.parametrize(
        ("text", "decimal", "expected"),
        [
            ("$1,234.56", ".", Decimal("1234.56")),
            ("1.234,56", ",", Decimal("1234.56")),
            ("1 234,56", ",", Decimal("1234.56")),
            ("1 234,56", ",", Decimal("1234.56")),
            ("1 234,56", ",", Decimal("1234.56")),
            ("1'234.50", ".", Decimal("1234.50")),
            ("(123.45)", ".", Decimal("-123.45")),
            ("123.45-", ".", Decimal("-123.45")),
            ("−5", ".", Decimal("-5")),
            ("+7", ".", Decimal("7")),
            ("€ 12,50", ",", Decimal("12.50")),
            ("12.50 EUR", ".", Decimal("12.50")),
            ("USD 3", ".", Decimal("3")),
        ],
    )
    def test_strings(self, text: str, decimal: str, expected: Decimal) -> None:
        assert parse_number(text, decimal) == expected  # type: ignore[arg-type]

    def test_native_values(self) -> None:
        assert parse_number(5) == Decimal(5)
        assert parse_number(0.1) == Decimal("0.1")
        assert parse_number(Decimal("2.50")) == Decimal("2.50")

    @pytest.mark.parametrize("cell", ["", "-", "—", "n/a", "Free", None])
    def test_blanks(self, cell: str | None) -> None:
        assert parse_number(cell) is None

    def test_junk_raises(self) -> None:
        with pytest.raises(ValueError):
            parse_number("abc")

    def test_date_raises(self) -> None:
        with pytest.raises(ValueError):
            parse_number(date(2024, 1, 15))

    def test_bool_raises(self) -> None:
        with pytest.raises(ValueError):
            parse_number(True)


class TestInferDecimal:
    def test_us(self) -> None:
        assert infer_decimal(["1,234.56", "12.5"]) == "."

    def test_eu(self) -> None:
        assert infer_decimal(["1.234,56", "12,5"]) == ","

    def test_ambiguous_uses_default(self) -> None:
        assert infer_decimal(["1,234", "5"]) == "."
        assert infer_decimal(["1,234", "5"], default=",") == ","

    def test_dates_not_counted(self) -> None:
        assert infer_decimal(["15.01.2024", "16.01.2024", "1,234.56"]) == "."


class TestLooksNumeric:
    @pytest.mark.parametrize("cell", ["1,234.56", "(5)", 3])
    def test_true(self, cell: str | int) -> None:
        assert looks_numeric(cell)

    @pytest.mark.parametrize("cell", ["15.01.2024", "VTI", "", True])
    def test_false(self, cell: str | bool) -> None:
        assert not looks_numeric(cell)


class TestInferDateOrder:
    def test_dmy(self) -> None:
        assert infer_date_order(["13/01/2024", "02/01/2024"]) == "DMY"

    def test_mdy(self) -> None:
        assert infer_date_order(["01/13/2024"]) == "MDY"

    def test_ymd(self) -> None:
        assert infer_date_order(["2024-01-15"]) == "YMD"

    def test_ambiguous_default(self) -> None:
        assert infer_date_order(["01/02/2024"]) == "MDY"
        assert infer_date_order(["01/02/2024"], default="DMY") == "DMY"


class TestParseDate:
    @pytest.mark.parametrize(
        ("text", "order", "expected"),
        [
            ("01/15/2024", "MDY", date(2024, 1, 15)),
            ("15/01/2024", "DMY", date(2024, 1, 15)),
            ("15.01.2024", "DMY", date(2024, 1, 15)),
            ("15.01.24", "DMY", date(2024, 1, 15)),
            ("2024-01-15T10:30:00", "MDY", date(2024, 1, 15)),
            ("2024/01/15", "MDY", date(2024, 1, 15)),
            ("20240115", "MDY", date(2024, 1, 15)),
            ("15 Jan 2024", "MDY", date(2024, 1, 15)),
            ("Jan 15, 2024", "MDY", date(2024, 1, 15)),
            ("15. März 2024", "DMY", date(2024, 3, 15)),
            ("3 déc. 2023", "DMY", date(2023, 12, 3)),
            ("01/15/2024", "DMY", date(2024, 1, 15)),  # >12 field overrides order
        ],
    )
    def test_strings(self, text: str, order: str, expected: date) -> None:
        assert parse_date(text, order) == expected  # type: ignore[arg-type]

    def test_native(self) -> None:
        assert parse_date(date(2024, 1, 15)) == date(2024, 1, 15)
        assert parse_date(datetime(2024, 1, 15, 10, 30)) == date(2024, 1, 15)

    def test_excel_serial(self) -> None:
        assert parse_date(45306) == date(2024, 1, 15)

    @pytest.mark.parametrize("text", ["garbage", "02/30/2024"])
    def test_invalid(self, text: str) -> None:
        with pytest.raises(ValueError):
            parse_date(text)


@given(st.integers(min_value=-(10**11), max_value=10**11))
def test_number_round_trip_us_and_eu(cents: int) -> None:
    x = Decimal(cents) / 100
    us = f"{x:,.2f}"
    eu = us.replace(",", "\x00").replace(".", ",").replace("\x00", ".")
    assert parse_number(us, ".") == x
    assert parse_number(eu, ",") == x


_DATES = st.dates(min_value=date(1990, 1, 1), max_value=date(2100, 12, 31))


@given(_DATES)
def test_date_round_trips(d: date) -> None:
    assert parse_date(d.strftime("%d.%m.%Y"), "DMY") == d
    assert parse_date(d.strftime("%m/%d/%Y"), "MDY") == d
    for order in ("MDY", "DMY", "YMD"):
        assert parse_date(d.isoformat(), order) == d  # type: ignore[arg-type]
