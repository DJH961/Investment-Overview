"""Projection page (v2.8) — standalone home for the interactive forecast tool.

The dual-currency projection tool used to be embedded (identically) on
both ``/monthly`` and ``/yearly``. v2.8 extracts it into its own page so
it lives in exactly one place. A granularity toggle lets the user run it
month-by-month or year-by-year; flipping it rebuilds the seed and
re-renders the tool in place.
"""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.pages._projection_view import build_seed
from investment_dashboard.ui.pages._projection_view import render as render_projection

PATH = "/projection"


def register() -> None:
    @ui.page(PATH)
    def _projection() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Projection", current=PATH):
            page_header(
                "Projection",
                subtitle="Project your portfolio forward in both currencies",
            )

            state = {"monthly": False}
            body = ui.column().classes("w-full")

            def _render() -> None:
                body.clear()
                with session_scope() as session:
                    display_ccy = display_currency_service.get_display_currency(session)
                    seed = build_seed(session, monthly=state["monthly"], primary=display_ccy)
                with body, section("Projection"):
                    render_projection(seed)

            def _on_toggle(value: str) -> None:
                state["monthly"] = value == "Monthly"
                _render()

            with ui.row().classes("items-center gap-md q-mb-sm"):
                ui.label("Granularity").classes("text-caption opacity-70")
                ui.toggle(
                    ["Yearly", "Monthly"],
                    value="Yearly",
                    on_change=lambda e: _on_toggle(e.value),
                ).props("no-caps")

            _render()
