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
from investment_dashboard.services import chart_prefs_service, display_currency_service
from investment_dashboard.ui.components import deferred, page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.pages._projection_view import ProjectionSeed, build_seed
from investment_dashboard.ui.pages._projection_view import render as render_projection

PATH = "/projection"
#: Persisted-preference key for the projection granularity toggle.
_PROJECTION_GRANULARITY_PREF = "projection_granularity"


def register() -> None:
    @ui.page(PATH)
    def _projection() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Projection", current=PATH):
            page_header(
                "Projection",
                subtitle="Project your portfolio forward in both currencies",
            )

            with session_scope() as session:
                _initial_gran = chart_prefs_service.get_pref(
                    session,
                    _PROJECTION_GRANULARITY_PREF,
                    default="Yearly",
                    allowed=("Yearly", "Monthly"),
                )
            state = {"monthly": _initial_gran == "Monthly"}
            body = ui.column().classes("w-full")

            def _gather() -> ProjectionSeed:
                # Heavy seed building (metrics + history) runs off the event
                # loop so the websocket stays responsive while it crunches.
                with session_scope() as session:
                    display_ccy = display_currency_service.get_display_currency(session)
                    return build_seed(session, monthly=state["monthly"], primary=display_ccy)

            def _build(seed: ProjectionSeed) -> None:
                with section("Projection"):
                    render_projection(seed)

            def _render() -> None:
                body.clear()
                with body:
                    deferred(_build, compute=_gather, label="Projecting…")

            def _on_toggle(value: str) -> None:
                state["monthly"] = value == "Monthly"
                # Remember the granularity so it sticks across visits/reloads.
                with session_scope() as session:
                    chart_prefs_service.set_pref(session, _PROJECTION_GRANULARITY_PREF, value)
                _render()

            with ui.row().classes("items-center gap-md q-mb-sm"):
                ui.label("Granularity").classes("text-caption opacity-70")
                ui.toggle(
                    ["Yearly", "Monthly"],
                    value=_initial_gran,
                    on_change=lambda e: _on_toggle(e.value),
                ).props("no-caps")

            _render()
