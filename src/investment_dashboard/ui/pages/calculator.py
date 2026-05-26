"""Investment calculator (spec §8.6) — placeholder shell wired in v0.5."""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.ui.layout import page_frame

PATH = "/calculator"


def register() -> None:
    @ui.page(PATH)
    def _calculator() -> None:  # pragma: no cover
        with page_frame("Calculator", current=PATH):
            ui.label("Investment calculator").classes("text-h5")
            ui.label("Cash-to-deploy rebalance planner lands in v0.9.").classes(
                "text-body2 opacity-70"
            )
