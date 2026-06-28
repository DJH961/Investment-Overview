"""Tests for the Yearly all-time growth Plotly figure (multi-currency view)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import plotly.graph_objects as go

from investment_dashboard.ui.charts import padded_range
from investment_dashboard.ui.pages._overview_query import ValueSeriesPoint
from investment_dashboard.ui.pages.yearly import _figure
from investment_dashboard.ui.theme import register_plotly_template

# The figure uses the app's custom Plotly template; register it for these tests.
register_plotly_template()


def _pts(values: list[float]) -> list[ValueSeriesPoint]:
    return [
        ValueSeriesPoint(date=date(2024, 6, 1 + i), value=Decimal(str(v)))
        for i, v in enumerate(values)
    ]


def _has_secondary_axis(fig: go.Figure) -> bool:
    return "yaxis2" in fig.layout.to_plotly_json()


class TestSecondaryCurrencyAxis:
    def test_no_secondary_keeps_single_axis(self) -> None:
        fig = _figure(_pts([100, 110]), currency="EUR")
        assert not _has_secondary_axis(fig)
        assert fig.layout.showlegend is False
        assert fig.layout.title.text == "Portfolio value over time (EUR)"

    def test_secondary_axis_shares_starting_point(self) -> None:
        primary = _pts([100, 120])  # +20% in EUR
        secondary = _pts([200, 260])  # +30% in USD, different absolute level
        fig = _figure(
            primary,
            currency="EUR",
            secondary=secondary,
            secondary_currency="USD",
        )
        # A right-hand axis is added, the legend turned on and both lines drawn.
        assert _has_secondary_axis(fig)
        assert fig.layout.showlegend is True
        assert [t.name for t in fig.data] == ["In EUR", "In USD"]
        assert fig.layout.title.text == "Portfolio value over time — EUR vs USD"

        scale = 200.0 / 100.0  # secondary[0] / primary[0]
        # The left range is fitted to BOTH lines: the primary values plus the
        # companion values mapped into primary units (secondary ÷ scale).
        left_lo, left_hi = padded_range([100.0, 120.0, 200.0 / scale, 260.0 / scale])
        r2_lo, r2_hi = fig.layout.yaxis2.range
        assert r2_lo == left_lo * scale
        assert r2_hi == left_hi * scale

        # Shared starting point: the first secondary value lands on the same axis
        # fraction as the first primary value (so both lines start at one pixel).
        def frac(value: float, lo: float, hi: float) -> float:
            return (value - lo) / (hi - lo)

        assert frac(200.0, r2_lo, r2_hi) == frac(100.0, left_lo, left_hi)

        # The companion line really is plotted against the right axis.
        sec_traces = [t for t in fig.data if getattr(t, "yaxis", None) == "y2"]
        assert len(sec_traces) == 1

    def test_axis_encloses_diverging_companion_line(self) -> None:
        # A companion (USD) line that diverges far above the primary (EUR) line —
        # as happens over the long all-time window when EUR/USD drifts — must stay
        # fully inside both axes rather than running off the top.
        primary = _pts([100, 101, 102])  # almost flat in EUR
        secondary = _pts([100, 130, 160])  # +60% in USD
        fig = _figure(
            primary,
            currency="EUR",
            secondary=secondary,
            secondary_currency="USD",
        )
        left_lo, left_hi = fig.layout.yaxis.range
        r2_lo, r2_hi = fig.layout.yaxis2.range
        assert left_lo <= 100.0
        assert left_hi >= 102.0
        assert r2_lo <= 100.0
        assert r2_hi >= 160.0

    def test_secondary_ignored_when_lengths_mismatch(self) -> None:
        fig = _figure(
            _pts([100, 120]),
            currency="EUR",
            secondary=_pts([200, 260, 300]),
            secondary_currency="USD",
        )
        assert not _has_secondary_axis(fig)
