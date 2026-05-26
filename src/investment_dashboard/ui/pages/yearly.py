"""Yearly page (spec §8.5) — placeholder shell wired in v0.5."""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.ui.layout import page_frame

PATH = "/yearly"


def register() -> None:
    @ui.page(PATH)
    def _yearly() -> None:  # pragma: no cover
        with page_frame("Yearly Growth", current=PATH):
            ui.label("Yearly growth with projection").classes("text-h5")
            ui.label("Table + chart + hypothetical block land in v0.9.").classes(
                "text-body2 opacity-70"
            )
