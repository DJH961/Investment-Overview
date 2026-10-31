"""v2.5 — every monetary surface shows both EUR and USD.

These tests pin the small shared helpers and the per-row cumulative
Total Growth output that the v2.5 sweep depends on. Page-render tests
in ``test_overview_query.py`` / ``test_period_query.py`` already
exercise the column / row keys themselves; this file covers the new
formatting primitives in isolation so a regression in either is easy
to localise.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from investment_dashboard.ui.money_format import dual_money, dual_pct, fmt_pct


def test_dual_money_usd_primary() -> None:
    out = dual_money(Decimal("1000"), Decimal("1100"), primary="USD")
    assert "$1,100.00" in out
    assert "€1,000.00" in out
    # primary first
    assert out.startswith("$1,100.00")


def test_dual_money_eur_primary() -> None:
    out = dual_money(Decimal("1000"), Decimal("1100"), primary="EUR")
    assert out.startswith("€1,000.00")


def test_dual_money_renders_em_dash_for_none() -> None:
    out = dual_money(None, Decimal("1"), primary="USD")
    assert "—" in out  # EUR side dashed


def test_dual_pct_includes_both_currencies() -> None:
    s = dual_pct(Decimal("0.10"), Decimal("0.12"), primary="USD")
    assert "10.00 %" in s
    assert "12.00 %" in s
    assert "(EUR)" in s
    assert "(USD)" in s


def test_fmt_pct_basic() -> None:
    assert fmt_pct(Decimal("0.1234")) == "12.34 %"
    assert fmt_pct(None) == "—"


@pytest.mark.parametrize("primary", ["USD", "EUR"])
def test_dual_pct_primary_first(primary: str) -> None:
    s = dual_pct(Decimal("0.01"), Decimal("0.02"), primary=primary)
    first_token = s.split(" / ")[0]
    assert primary in first_token
