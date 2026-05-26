"""Overview page (spec §8.1) — placeholder shell wired in v0.5.

The real KPI cards / per-instrument table / allocation treemap land in v0.8.
For now we render the page frame and a "coming soon" notice so the UI shell
can be navigated end-to-end.
"""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.ui.components.kpi_card import kpi_card
from investment_dashboard.ui.layout import page_frame

PATH = "/overview"


def register() -> None:
    @ui.page(PATH)
    def _overview() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Overview", current=PATH):
            ui.label("Portfolio at a glance").classes("text-h5")
            with ui.row().classes("gap-md flex-wrap"):
                kpi_card("Total Value", "—", sub="EUR —", tooltip_key="total_value")
                kpi_card("Total Gain", "—", sub="— %", tooltip_key="total_gain")
                kpi_card("XIRR", "—", tooltip_key="xirr")
                kpi_card("YTD Growth", "—", tooltip_key="ytd_growth")
            ui.separator()
            ui.label(
                "Per-instrument table and allocation treemap land in v0.8. "
                "Use Transactions → Import CSV to load broker data."
            ).classes("text-body2 opacity-70")
