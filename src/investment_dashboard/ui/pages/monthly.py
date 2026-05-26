"""Monthly page (spec §8.4) — placeholder shell wired in v0.5."""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.ui.layout import page_frame

PATH = "/monthly"


def register() -> None:
    @ui.page(PATH)
    def _monthly() -> None:  # pragma: no cover
        with page_frame("Monthly Growth", current=PATH):
            ui.label("Monthly growth with projection").classes("text-h5")
            ui.label("Table + chart land in v0.9.").classes("text-body2 opacity-70")
