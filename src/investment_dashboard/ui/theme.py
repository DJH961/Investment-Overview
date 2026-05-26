"""Colorblind-safe palette + Plotly template (spec §11).

Reference: Wong, B. *Points of view: Color blindness.* Nat Methods 8, 441 (2011).
The palette is friendly to deuteranopia and protanopia. We never use red↔green
as the only signal for gain/loss; gains are **blue (#0072B2)** and losses are
**orange (#E69F00)**, optionally with directional arrows.
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# Palette
# ---------------------------------------------------------------------------

#: Wong colorblind-safe palette.
WONG: Final[dict[str, str]] = {
    "black": "#000000",
    "orange": "#E69F00",  # loss
    "sky": "#56B4E9",
    "green": "#009E73",
    "yellow": "#F0E442",
    "blue": "#0072B2",  # gain
    "vermillion": "#D55E00",
    "purple": "#CC79A7",
}

GAIN_COLOR: Final[str] = WONG["blue"]
LOSS_COLOR: Final[str] = WONG["orange"]
NEUTRAL_COLOR: Final[str] = WONG["sky"]

#: Default ordered qualitative palette for Plotly charts.
PLOTLY_QUALITATIVE: Final[list[str]] = [
    WONG["blue"],
    WONG["orange"],
    WONG["sky"],
    WONG["green"],
    WONG["yellow"],
    WONG["vermillion"],
    WONG["purple"],
    WONG["black"],
]


def color_for_signed(value: float) -> str:
    """Return the gain/loss color for a numeric value (zero → neutral)."""
    if value > 0:
        return GAIN_COLOR
    if value < 0:
        return LOSS_COLOR
    return NEUTRAL_COLOR


def arrow_for_signed(value: float) -> str:
    """Return ``↑``/``↓``/``·`` so direction is encoded redundantly to color."""
    if value > 0:
        return "↑"
    if value < 0:
        return "↓"
    return "·"


# ---------------------------------------------------------------------------
# Plotly template
# ---------------------------------------------------------------------------


def register_plotly_template(name: str = "colorblind") -> None:
    """Register the Wong palette as a named Plotly template.

    Idempotent — safe to call from import-time module init or from boot.
    Importing plotly is intentionally lazy so this module stays cheap to import.
    """
    import plotly.graph_objects as go  # noqa: PLC0415 - lazy
    import plotly.io as pio  # noqa: PLC0415 - lazy

    if name in pio.templates:
        return

    template = go.layout.Template(
        layout=go.Layout(
            font={"family": "Inter, system-ui, sans-serif", "color": "#1f1f1f"},
            colorway=PLOTLY_QUALITATIVE,
            paper_bgcolor="#ffffff",
            plot_bgcolor="#ffffff",
            xaxis={"gridcolor": "#e6e6e6", "zerolinecolor": "#cccccc"},
            yaxis={"gridcolor": "#e6e6e6", "zerolinecolor": "#cccccc"},
            legend={"bgcolor": "rgba(255,255,255,0.85)", "bordercolor": "#cccccc"},
        )
    )
    pio.templates[name] = template
    pio.templates.default = name
