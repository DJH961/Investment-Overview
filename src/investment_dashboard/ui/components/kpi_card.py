"""KPI card — large value, small label, optional sub-line and tooltip.

Used by the Overview page's top strip (spec §8.1) and reusable elsewhere.
"""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.ui.components.tooltip_label import label_with_tooltip


def kpi_card(
    label: str,
    value: str,
    *,
    sub: str | None = None,
    tooltip_key: str | None = None,
    color: str | None = None,
    arrow: str | None = None,
) -> None:
    """Render a single KPI card.

    Args:
        label: short title above the big number.
        value: the primary value, already formatted.
        sub: optional secondary line (e.g. EUR equivalent or % change).
        tooltip_key: a key into :mod:`investment_dashboard.ui.copy.tooltips`.
        color: hex foreground for the value (defaults to theme primary).
        arrow: optional ↑/↓ directional indicator (colorblind redundancy).
    """
    with ui.card().classes("min-w-[12rem] q-pa-md shadow-2"):
        if tooltip_key:
            label_with_tooltip(label, tooltip_key, classes="text-overline opacity-70")
        else:
            ui.label(label).classes("text-overline opacity-70")
        with ui.row().classes("items-baseline gap-xs"):
            if arrow:
                ui.label(arrow).classes("text-h5").style(f"color: {color}" if color else "")
            ui.label(value).classes("text-h4").style(f"color: {color}" if color else "")
        if sub:
            ui.label(sub).classes("text-caption opacity-70")
