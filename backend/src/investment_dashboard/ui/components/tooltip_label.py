"""``label_with_tooltip`` — a small helper used wherever a metric needs an
information ``i`` icon hover.

Kept here (rather than inline in pages) so tooltip presentation is consistent.

v1.5: switched icon to ``info_outline`` at 14 px so it is less visually
intrusive next to the small uppercase KPI labels.
"""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.ui.copy import tooltips


def label_with_tooltip(text: str, tooltip_key: str, *, classes: str = "") -> None:
    """Render ``text`` followed by a small info icon that shows the tooltip.

    The tooltip body comes from :mod:`investment_dashboard.ui.copy.tooltips`
    so wording stays in one place.
    """
    body = tooltips.get(tooltip_key)
    with ui.row().classes(f"items-center gap-xs no-wrap {classes}".strip()):
        ui.html(f"<span>{text}</span>")
        if body:
            with ui.icon("info_outline").classes("cursor-help").style("font-size:14px;opacity:.55"):
                ui.tooltip(body).props("max-width=320px")
