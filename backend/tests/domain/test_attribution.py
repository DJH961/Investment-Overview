"""Tests for ``investment_dashboard.domain.attribution``."""

from __future__ import annotations

from decimal import Decimal

from investment_dashboard.domain.attribution import (
    InstrumentReturn,
    attribute_portfolio_return,
)


def D(x: float | int) -> Decimal:
    return Decimal(repr(x))


def test_pnl_sums_match_portfolio_total() -> None:
    rows = [
        InstrumentReturn(1, "VTI", D(1000), D(1100), D(0)),
        InstrumentReturn(2, "BND", D(500), D(490), D(0)),
        InstrumentReturn(3, "VXUS", D(800), D(820), D(20)),
    ]
    out = attribute_portfolio_return(rows)
    total_pnl = sum((r.absolute_pnl for r in out), start=Decimal(0))
    # 100 + (-10) + 0 = 90
    assert total_pnl == Decimal(90)


def test_pct_uses_starting_total_value() -> None:
    rows = [
        InstrumentReturn(1, "A", D(100), D(110), D(0)),
        InstrumentReturn(2, "B", D(100), D(100), D(0)),
    ]
    out = attribute_portfolio_return(rows)
    by_sym = {r.symbol: r for r in out}
    # A gained 10 of 200 = 5%; B 0%.
    assert by_sym["A"].pct_of_total_return == Decimal("0.05")
    assert by_sym["B"].pct_of_total_return == Decimal(0)


def test_dividends_increase_pnl() -> None:
    rows = [InstrumentReturn(1, "X", D(100), D(100), D(0), dividends_cash=D(5))]
    out = attribute_portfolio_return(rows)
    assert out[0].absolute_pnl == Decimal(5)


def test_sorted_by_absolute_pnl_desc() -> None:
    rows = [
        InstrumentReturn(1, "A", D(100), D(105), D(0)),  # +5
        InstrumentReturn(2, "B", D(100), D(80), D(0)),  # -20
        InstrumentReturn(3, "C", D(100), D(101), D(0)),  # +1
    ]
    out = attribute_portfolio_return(rows)
    assert [r.symbol for r in out] == ["B", "A", "C"]


def test_zero_start_falls_back_to_end_value() -> None:
    rows = [
        InstrumentReturn(1, "A", D(0), D(100), D(50)),  # net +50
        InstrumentReturn(2, "B", D(0), D(100), D(100)),  # net 0
    ]
    out = attribute_portfolio_return(rows)
    by_sym = {r.symbol: r for r in out}
    # Denominator falls back to total end = 200. A pnl = 50.
    assert by_sym["A"].pct_of_total_return == Decimal("0.25")
    assert by_sym["B"].pct_of_total_return == Decimal(0)


def test_all_zero_returns_none_pct() -> None:
    rows = [InstrumentReturn(1, "A", D(0), D(0), D(0))]
    out = attribute_portfolio_return(rows)
    assert out[0].pct_of_total_return is None
