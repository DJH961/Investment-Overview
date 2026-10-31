"""Tests for v1.2 monthly projection and Modified-Dietz growth %."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from investment_dashboard.ui.pages._period_query import _modified_dietz
from investment_dashboard.ui.pages._projection_query import (
    project_monthly,
    to_monthly_table_rows,
)


def test_project_monthly_zero_growth_just_sums_contributions() -> None:
    rows = project_monthly(
        starting_value_eur=Decimal("1000"),
        monthly_contribution_eur=Decimal("100"),
        months=3,
        scenarios=(Decimal("0"),),
        start=date(2025, 1, 15),
    )
    assert [r.label for r in rows] == ["2025-02", "2025-03", "2025-04"]
    # 1000 + 100, +100, +100
    final_values = [r.values_by_rate[Decimal("0")] for r in rows]
    assert final_values == [Decimal("1100"), Decimal("1200"), Decimal("1300")]
    assert [r.contributed for r in rows] == [Decimal("100"), Decimal("200"), Decimal("300")]


def test_project_monthly_compounds_at_monthly_rate() -> None:
    # 12 % annual ≈ 0.9489 % monthly; check first month is roughly starting * 1.00949
    rows = project_monthly(
        starting_value_eur=Decimal("1000"),
        monthly_contribution_eur=Decimal("0"),
        months=12,
        scenarios=(Decimal("0.12"),),
    )
    first = rows[0].values_by_rate[Decimal("0.12")]
    assert Decimal("1009") < first < Decimal("1010")
    # After 12 months of pure compounding (no contributions) should ≈ 1120.
    last = rows[-1].values_by_rate[Decimal("0.12")]
    assert Decimal("1119") < last < Decimal("1121")


def test_project_monthly_year_rollover() -> None:
    rows = project_monthly(
        starting_value_eur=Decimal("0"),
        monthly_contribution_eur=Decimal("1"),
        months=14,
        scenarios=(Decimal("0"),),
        start=date(2025, 11, 1),
    )
    assert rows[0].label == "2025-12"
    assert rows[1].label == "2026-01"
    assert rows[-1].label == "2027-01"


def test_to_monthly_table_rows_formats_columns() -> None:
    rows = project_monthly(
        starting_value_eur=Decimal("0"),
        monthly_contribution_eur=Decimal("100"),
        months=1,
        scenarios=(Decimal("0.07"),),
        start=date(2025, 1, 1),
    )
    rendered = to_monthly_table_rows(rows, currency="USD", fx_rate=Decimal("1.2"))
    assert rendered[0]["label"] == "2025-02"
    assert rendered[0]["contributed"] == "120.00"
    assert rendered[0]["contributed_eur"] == "100.00"
    assert rendered[0]["contributed_usd"] == "120.00"
    assert "rate_0.07" in rendered[0]
    assert "rate_0.07_eur" in rendered[0]
    assert "rate_0.07_usd" in rendered[0]


def test_modified_dietz_basic() -> None:
    # Started at 1000, ended at 1200, contributed 100 net. r ≈ (1200 - 1000 - 100) / (1050)
    r = _modified_dietz(Decimal("1000"), Decimal("1200"), Decimal("100"))
    assert r is not None
    assert Decimal("0.09") < r < Decimal("0.10")


def test_modified_dietz_negative_denominator_returns_none() -> None:
    assert _modified_dietz(Decimal("0"), Decimal("100"), Decimal("-1000")) is None
