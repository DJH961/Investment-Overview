"""Tests for ``investment_dashboard.domain.currency``."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from investment_dashboard.domain.currency import (
    eur_to_native,
    lookup_rate_with_forward_fill,
    native_to_eur,
)


class TestConversion:
    def test_native_to_eur_basic(self) -> None:
        # 108.50 USD at 1 EUR = 1.085 USD ⇒ 100.00 EUR
        result = native_to_eur(Decimal("108.50"), Decimal("1.085"))
        assert result == Decimal("100")

    def test_eur_to_native_basic(self) -> None:
        result = eur_to_native(Decimal("100"), Decimal("1.085"))
        assert result == Decimal("108.500")

    def test_round_trip(self) -> None:
        amt = Decimal("12345.678901")
        rate = Decimal("1.07234")
        assert native_to_eur(eur_to_native(amt, rate), rate) == amt

    @pytest.mark.parametrize("bad_rate", [Decimal(0), Decimal("-1")])
    def test_invalid_rate_raises(self, bad_rate: Decimal) -> None:
        with pytest.raises(ValueError, match="positive"):
            native_to_eur(Decimal(100), bad_rate)
        with pytest.raises(ValueError, match="positive"):
            eur_to_native(Decimal(100), bad_rate)


class TestForwardFill:
    def test_exact_hit(self) -> None:
        rates = {date(2024, 1, 2): Decimal("1.10"), date(2024, 1, 3): Decimal("1.11")}
        assert lookup_rate_with_forward_fill(rates, date(2024, 1, 3)) == Decimal("1.11")

    def test_weekend_inherits_friday(self) -> None:
        rates = {date(2024, 1, 5): Decimal("1.09")}  # Friday
        # Sunday looks back to Friday.
        assert lookup_rate_with_forward_fill(rates, date(2024, 1, 7)) == Decimal("1.09")

    def test_before_any_data_returns_none(self) -> None:
        rates = {date(2024, 1, 5): Decimal("1.09")}
        assert lookup_rate_with_forward_fill(rates, date(2024, 1, 4)) is None

    def test_empty_returns_none(self) -> None:
        assert lookup_rate_with_forward_fill({}, date(2024, 1, 1)) is None
