"""Tests for the overview Positions table column helpers.

These cover the presentation tweaks that make winners/losers easy to scan and
open the table sorted by Value: the ``_money_column`` helper's ``sort`` and
``color_by_sign`` options.
"""

from __future__ import annotations

from investment_dashboard.ui.pages.overview import _money_column


def test_money_column_default_has_no_sort_or_sign_colour() -> None:
    col = _money_column("Cost Basis", "cost_basis", "EUR")
    assert col["field"] == "cost_basis_eur_num"
    assert "sort" not in col
    assert "cellClassRules" not in col


def test_money_column_accepts_desc_sort_parameter() -> None:
    col = _money_column("Value", "value", "EUR", sort="desc")
    assert col["field"] == "value_eur_num"
    assert col["sort"] == "desc"


def test_money_column_colour_by_sign_targets_numeric_companion() -> None:
    col = _money_column("Capital Gain", "capital_gain", "USD", color_by_sign=True)
    rules = col["cellClassRules"]
    assert rules == {
        "inv-cell-pos": "data.capital_gain_usd_num > 0",
        "inv-cell-neg": "data.capital_gain_usd_num < 0",
    }
