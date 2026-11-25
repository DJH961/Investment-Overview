# ruff: noqa: PT018
"""Tests for ``domain.cash_out`` beyond the G1/G2 goldens (fees, missing rate)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from investment_dashboard.domain.cash_out import cash_out
from investment_dashboard.domain.cash_pool import ConversionBack, Draw, Origin

D = Decimal
ON = date(2026, 6, 1)
DRAW = Draw(
    9,
    "withdrawal:9:0",
    D("100"),
    D("70"),
    D("10"),
    (Origin(1, date(2026, 1, 1), D("70")),),
)


def test_fees_reduce_the_euros_back_and_count_as_conversion_cost() -> None:
    # $100 at ECB 1.25 = EUR 80; received EUR 79, fees EUR 1 -> EUR 78 really back.
    co = cash_out(
        ConversionBack(5, ON, "USD", D("100"), D("79"), D("1")), [DRAW], lambda c, d: D("1.25")
    )
    assert co.orig_eur == D("70") and co.market_eur == D("10")
    assert co.currency_eur == D(0)  # EUR 80 at ECB = book EUR 80
    assert co.conversion_cost_eur == D("-2")
    assert co.realised_eur == D("8")
    assert co.realised_eur == co.market_eur + co.currency_eur + co.conversion_cost_eur


def test_missing_rate_uses_the_rate_obtained_and_flags() -> None:
    co = cash_out(ConversionBack(5, ON, "USD", D("100"), D("90")), [DRAW], lambda c, d: None)
    assert co.flagged and co.conversion_cost_eur == 0
    assert co.currency_eur == D("10")
    assert co.realised_eur == co.market_eur + co.currency_eur + co.conversion_cost_eur


def test_no_origin_euros_gives_no_return() -> None:
    income = Draw(9, "income:3:0", D("10"), D(0), D("8"), (Origin(None, None, D(0)),))
    co = cash_out(ConversionBack(5, ON, "USD", D("10"), D("8")), [income], lambda c, d: D("1.25"))
    assert co.xirr_eur is None and co.realised_eur == D("8")
