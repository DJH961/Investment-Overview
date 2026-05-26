"""Settings page (spec §8.7) — placeholder shell wired in v0.5."""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.ui.layout import page_frame

PATH = "/settings"


def register() -> None:
    @ui.page(PATH)
    def _settings() -> None:  # pragma: no cover
        with page_frame("Settings", current=PATH):
            ui.label("Settings").classes("text-h5")
            ui.label("Account / instrument / allocation management lands in v0.9.").classes(
                "text-body2 opacity-70"
            )
