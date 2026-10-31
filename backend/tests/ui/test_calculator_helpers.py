"""Tests for the Calculator page's pure helpers (normalisation / parsing)."""

from __future__ import annotations

from decimal import Decimal

from investment_dashboard.ui.pages.calculator import (
    _bar,
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


def test_bar_without_added_slice_has_no_added_segment() -> None:
    """The base bar (no contribution context) draws only the fill + target."""
    html = _bar(Decimal(40), Decimal(50))
    assert "inv-gain" not in html
    assert "width:40.0%" in html  # current/after fill
    assert "calc(50.0% - 1px)" in html  # target marker


def test_bar_added_slice_is_visible_even_when_tiny() -> None:
    """A tiny contribution still renders a visible (min-width) accent slice."""
    html = _bar(Decimal(40), Decimal(50), added_from=Decimal("39.5"))
    assert "inv-gain" in html  # the added (contribution) slice is drawn
    # 0.5 % of growth is floored to a 3 % visible width, anchored at the edge.
    assert "width:3.0%" in html
    assert "left:37.0%" in html


def test_bar_added_slice_absent_when_no_growth() -> None:
    """When the contribution does not move the fill, no accent slice appears."""
    html = _bar(Decimal(40), Decimal(50), added_from=Decimal(40))
    assert "inv-gain" not in html
