"""UI helper tests — theme palette + Plotly template + tooltip copy."""

from __future__ import annotations

import pytest

from investment_dashboard.ui.copy import tooltips
from investment_dashboard.ui.theme import (
    GAIN_COLOR,
    LOSS_COLOR,
    NEUTRAL_COLOR,
    PLOTLY_QUALITATIVE,
    WONG,
    arrow_for_signed,
    color_for_signed,
    register_plotly_template,
)


def test_palette_uses_wong_keys() -> None:
    assert GAIN_COLOR == WONG["blue"] == "#0072B2"
    assert LOSS_COLOR == WONG["orange"] == "#E69F00"
    assert WONG["sky"] == NEUTRAL_COLOR


def test_palette_has_eight_distinct_colors() -> None:
    assert len(set(PLOTLY_QUALITATIVE)) == 8


@pytest.mark.parametrize(
    ("value", "color", "arrow"),
    [
        (1.5, GAIN_COLOR, "↑"),
        (-1.5, LOSS_COLOR, "↓"),
        (0.0, NEUTRAL_COLOR, "·"),
    ],
)
def test_signed_helpers(value: float, color: str, arrow: str) -> None:
    assert color_for_signed(value) == color
    assert arrow_for_signed(value) == arrow


def test_register_plotly_template_idempotent() -> None:
    import plotly.io as pio

    register_plotly_template()
    register_plotly_template()  # second call must not raise
    assert "colorblind" in pio.templates


class TestTooltips:
    def test_every_kpi_key_present(self) -> None:
        for key in (
            "total_value",
            "total_gain",
            "xirr",
            "twr",
            "cagr",
            "ytd_growth",
            "max_drawdown",
            "sharpe",
            "sortino",
        ):
            assert tooltips.get(key), f"missing tooltip copy for {key}"

    def test_missing_key_returns_empty(self) -> None:
        assert tooltips.get("does_not_exist") == ""

    def test_copy_under_three_sentences(self) -> None:
        # Spec §10: "Copy must be plain English, ≤ 3 sentences."
        for key, body in tooltips.TOOLTIPS.items():
            sentence_count = body.count(".") + body.count("?") + body.count("!")
            assert sentence_count <= 3, f"{key} has too many sentences: {body!r}"
