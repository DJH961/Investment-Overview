"""Deposits page (spec §8.2) — placeholder shell wired in v0.5."""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.ui.layout import page_frame

PATH = "/deposits"


def register() -> None:
    @ui.page(PATH)
    def _deposits() -> None:  # pragma: no cover
        with page_frame("Deposits", current=PATH):
            ui.label("Deposits, withdrawals and interest").classes("text-h5")
            ui.label("Coming in v0.7 — summary cards and full deposits table.").classes(
                "text-body2 opacity-70"
            )
