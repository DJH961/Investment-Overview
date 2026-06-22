"""Tests for the Calculator page's pure helpers (normalisation / parsing)."""

from __future__ import annotations

from decimal import Decimal

from investment_dashboard.ui.pages.calculator import (
    _decimal_or_zero,
    _round_to_100,
    _scale_to_100,
)


def test_decimal_or_zero_parses_and_defaults() -> None:
    assert _decimal_or_zero("12.5") == Decimal("12.5")
    assert _decimal_or_zero(7) == Decimal(7)
    assert _decimal_or_zero("") == Decimal(0)
    assert _decimal_or_zero(None) == Decimal(0)
    assert _decimal_or_zero("oops") == Decimal(0)


def test_scale_to_100_preserves_ratios() -> None:
    scaled = _scale_to_100({1: Decimal(30), 2: Decimal(10)})
    assert scaled[1] == Decimal(75)
    assert scaled[2] == Decimal(25)
    assert sum(scaled.values()) == Decimal(100)


def test_scale_to_100_drops_non_positive_and_empty() -> None:
    assert _scale_to_100({1: Decimal(0), 2: Decimal(-1)}) == {}
    assert _scale_to_100({}) == {}


def test_round_to_100_absorbs_residual_into_largest() -> None:
    rounded = _round_to_100({1: Decimal("33.333"), 2: Decimal("33.333"), 3: Decimal("33.333")})
    assert sum(rounded.values()) == Decimal(100)
    # The largest bucket carries the rounding residual.
    assert max(rounded.values()) >= Decimal("33.3")
