"""Transactions page (spec §8.3) — placeholder shell wired in v0.5."""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.ui.layout import page_frame

PATH = "/transactions"


def register() -> None:
    @ui.page(PATH)
    def _transactions() -> None:  # pragma: no cover
        with page_frame("Transactions", current=PATH):
            ui.label("Master ledger").classes("text-h5")
            ui.label("Filterable table, manual entry, and CSV import land in v0.6.").classes(
                "text-body2 opacity-70"
            )
