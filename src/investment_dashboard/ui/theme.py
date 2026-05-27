"""Colorblind-safe palette, design tokens + Plotly templates (spec §11).

Reference: Wong, B. *Points of view: Color blindness.* Nat Methods 8, 441 (2011).
The palette is friendly to deuteranopia and protanopia. We never use red↔green
as the only signal for gain/loss; gains are **blue (#0072B2)** and losses are
**orange (#E69F00)**, optionally with directional arrows.

v1.5 layered on top of the original Wong palette a design-token system used by
the new "neo-fintech" chrome (see :mod:`investment_dashboard.ui.style`):
brand accent, semantic surfaces, spacing/radius/shadow scales, and a matching
``colorblind_dark`` Plotly template. Data colors are unchanged — only chrome.
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

    Also registers ``colorblind_modern`` (light) and ``colorblind_dark`` (dark)
    siblings that match the v1.5 "neo-fintech" chrome. ``colorblind`` is kept
    as the default for backwards compatibility with code that hard-codes the
    template name.
    """
    import plotly.graph_objects as go  # noqa: PLC0415 - lazy
    import plotly.io as pio  # noqa: PLC0415 - lazy

    base_font = {"family": "Inter, system-ui, sans-serif", "size": 13}

    if name not in pio.templates:
        pio.templates[name] = go.layout.Template(
            layout=go.Layout(
                font={**base_font, "color": "#1f1f1f"},
                colorway=PLOTLY_QUALITATIVE,
                paper_bgcolor="#ffffff",
                plot_bgcolor="#ffffff",
                xaxis={"gridcolor": "#e6e6e6", "zerolinecolor": "#cccccc"},
                yaxis={"gridcolor": "#e6e6e6", "zerolinecolor": "#cccccc"},
                legend={"bgcolor": "rgba(255,255,255,0.85)", "bordercolor": "#cccccc"},
            )
        )
        pio.templates.default = name

    if "colorblind_modern" not in pio.templates:
        pio.templates["colorblind_modern"] = go.layout.Template(
            layout=go.Layout(
                font={**base_font, "color": COLORS_LIGHT["ink"]},
                colorway=PLOTLY_QUALITATIVE,
                paper_bgcolor="rgba(0,0,0,0)",
                plot_bgcolor="rgba(0,0,0,0)",
                xaxis={
                    "gridcolor": COLORS_LIGHT["hairline"],
                    "zerolinecolor": COLORS_LIGHT["hairline"],
                    "linecolor": COLORS_LIGHT["hairline"],
                    "tickcolor": COLORS_LIGHT["hairline"],
                    "showline": False,
                    "ticks": "outside",
                },
                yaxis={
                    "gridcolor": COLORS_LIGHT["hairline"],
                    "zerolinecolor": COLORS_LIGHT["hairline"],
                    "linecolor": COLORS_LIGHT["hairline"],
                    "tickcolor": COLORS_LIGHT["hairline"],
                    "showline": False,
                    "ticks": "outside",
                },
                legend={
                    "bgcolor": "rgba(0,0,0,0)",
                    "bordercolor": "rgba(0,0,0,0)",
                    "orientation": "h",
                    "yanchor": "bottom",
                    "y": 1.02,
                    "xanchor": "right",
                    "x": 1.0,
                },
                margin={"l": 8, "r": 8, "t": 32, "b": 8},
                title={
                    "font": {"size": 15, "color": COLORS_LIGHT["ink"]},
                    "x": 0.0,
                    "xanchor": "left",
                },
                hoverlabel={
                    "bgcolor": "#ffffff",
                    "bordercolor": COLORS_LIGHT["hairline"],
                    "font": base_font,
                },
            )
        )

    if "colorblind_dark" not in pio.templates:
        pio.templates["colorblind_dark"] = go.layout.Template(
            layout=go.Layout(
                font={**base_font, "color": COLORS_DARK["ink"]},
                colorway=PLOTLY_QUALITATIVE,
                paper_bgcolor="rgba(0,0,0,0)",
                plot_bgcolor="rgba(0,0,0,0)",
                xaxis={
                    "gridcolor": COLORS_DARK["hairline"],
                    "zerolinecolor": COLORS_DARK["hairline"],
                    "linecolor": COLORS_DARK["hairline"],
                    "tickcolor": COLORS_DARK["hairline"],
                    "showline": False,
                    "ticks": "outside",
                },
                yaxis={
                    "gridcolor": COLORS_DARK["hairline"],
                    "zerolinecolor": COLORS_DARK["hairline"],
                    "linecolor": COLORS_DARK["hairline"],
                    "tickcolor": COLORS_DARK["hairline"],
                    "showline": False,
                    "ticks": "outside",
                },
                legend={
                    "bgcolor": "rgba(0,0,0,0)",
                    "bordercolor": "rgba(0,0,0,0)",
                    "orientation": "h",
                    "yanchor": "bottom",
                    "y": 1.02,
                    "xanchor": "right",
                    "x": 1.0,
                },
                margin={"l": 8, "r": 8, "t": 32, "b": 8},
                title={
                    "font": {"size": 15, "color": COLORS_DARK["ink"]},
                    "x": 0.0,
                    "xanchor": "left",
                },
                hoverlabel={
                    "bgcolor": COLORS_DARK["surface"],
                    "bordercolor": COLORS_DARK["hairline"],
                    "font": {**base_font, "color": COLORS_DARK["ink"]},
                },
            )
        )


# ---------------------------------------------------------------------------
# Design tokens (v1.5 — neo-fintech chrome)
# ---------------------------------------------------------------------------

#: Brand accent — deep indigo/teal, replaces bright Quasar primary.
BRAND: Final[str] = "#0F4C81"
BRAND_HOVER: Final[str] = "#0C3E69"

#: Light theme palette (chrome only — data colours come from WONG).
COLORS_LIGHT: Final[dict[str, str]] = {
    "canvas": "#F7F8FA",
    "surface": "#FFFFFF",
    "surface_alt": "#F1F4F8",
    "ink": "#0B1220",
    "muted": "#5B6B7C",
    "hairline": "#E5E9F0",
    "accent": BRAND,
    "accent_soft": "rgba(15, 76, 129, 0.08)",
    "accent_ring": "rgba(15, 76, 129, 0.35)",
}

#: Dark theme palette.
COLORS_DARK: Final[dict[str, str]] = {
    "canvas": "#0B1220",
    "surface": "#111A2B",
    "surface_alt": "#16213A",
    "ink": "#E6ECF3",
    "muted": "#9AA8BB",
    "hairline": "#1F2B40",
    "accent": "#4F8FCB",
    "accent_soft": "rgba(79, 143, 203, 0.14)",
    "accent_ring": "rgba(79, 143, 203, 0.45)",
}

#: Spacing scale (rems).
SPACING: Final[dict[str, str]] = {
    "xs": "0.25rem",
    "sm": "0.5rem",
    "md": "1rem",
    "lg": "1.5rem",
    "xl": "2rem",
}

#: Border radius scale.
RADIUS: Final[dict[str, str]] = {
    "sm": "6px",
    "md": "10px",
    "lg": "12px",
    "xl": "16px",
    "pill": "999px",
}

#: Subtle shadow used on cards/sections.
SHADOW_SOFT: Final[str] = "0 1px 2px rgba(11,18,32,.04), 0 1px 3px rgba(11,18,32,.06)"

#: Typography scale (rem values).
TYPESCALE: Final[dict[str, str]] = {
    "display": "2.25rem",
    "h1": "1.75rem",
    "h2": "1.375rem",
    "h3": "1.125rem",
    "body": "0.9375rem",
    "caption": "0.8125rem",
    "overline": "0.6875rem",
}


def design_tokens() -> dict[str, object]:
    """Return the full token map.

    Used by :mod:`investment_dashboard.ui.style` to emit CSS custom
    properties. Kept as a plain ``dict`` so tests can introspect it
    without importing NiceGUI.
    """
    return {
        "brand": BRAND,
        "brand_hover": BRAND_HOVER,
        "light": COLORS_LIGHT,
        "dark": COLORS_DARK,
        "spacing": SPACING,
        "radius": RADIUS,
        "shadow_soft": SHADOW_SOFT,
        "typescale": TYPESCALE,
        "gain": GAIN_COLOR,
        "loss": LOSS_COLOR,
        "neutral": NEUTRAL_COLOR,
    }
