"""Unit tests for the analytics page's display-currency helpers (audit E3)."""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from investment_dashboard.domain.attribution import AttributionRow
from investment_dashboard.ui.pages.analytics import _attribution_rows


def _bundle_with(row: AttributionRow) -> SimpleNamespace:
    # _attribution_rows only touches ``bundle.attribution``.
    return SimpleNamespace(attribution=[row])


_ROW = AttributionRow(
    instrument_id=1,
    symbol="VTI",
    start_value=Decimal("100"),
    end_value=Decimal("150"),
    net_contribution=Decimal("20"),
    absolute_pnl=Decimal("30"),
    pct_of_total_return=Decimal("0.5"),
)


def test_eur_display_leaves_values_unconverted() -> None:
    rows = _attribution_rows(_bundle_with(_ROW), rate=None)
    assert rows[0]["start_value"] == 100.0
    assert rows[0]["end_value"] == 150.0
    assert rows[0]["pct_of_total_return"] == 50.0


def test_usd_display_scales_every_money_column_by_the_rate() -> None:
    rows = _attribution_rows(_bundle_with(_ROW), rate=Decimal("1.2"))
    assert rows[0]["start_value"] == 120.0
    assert rows[0]["end_value"] == 180.0
    assert rows[0]["net_contribution"] == 24.0
    assert rows[0]["absolute_pnl"] == 36.0
    # The percentage column is rate-invariant.
    assert rows[0]["pct_of_total_return"] == 50.0
