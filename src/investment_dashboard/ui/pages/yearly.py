"""Yearly page (spec §8.5) — yearly aggregation table + bar chart + projection."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.pages._period_query import aggregate, to_table_rows
from investment_dashboard.ui.pages._projection_query import (
    DEFAULT_SCENARIOS,
    project_from_session,
)
from investment_dashboard.ui.pages._projection_query import (
    to_table_rows as projection_table_rows,
)
from investment_dashboard.ui.theme import GAIN_COLOR

PATH = "/yearly"


def _figure(rows):  # type: ignore[no-untyped-def]
    import plotly.graph_objects as go  # noqa: PLC0415

    fig = go.Figure()
    if rows:
        fig.add_bar(
            x=[r.label for r in rows],
            y=[float(r.contributions) for r in rows],
            name="Contributions",
            marker_color=GAIN_COLOR,
        )
        fig.add_bar(
            x=[r.label for r in rows],
            y=[float(r.dividends + r.interest) for r in rows],
            name="Dividends + Interest",
        )
    fig.update_layout(
        title="Yearly cashflows (EUR)",
        template="colorblind",
        barmode="stack",
        margin={"l": 40, "r": 20, "t": 40, "b": 40},
    )
    return fig


def _scenario_label(rate: Decimal) -> str:
    return f"{rate * 100:.1f}% p.a."


def register() -> None:
    @ui.page(PATH)
    def _yearly() -> None:  # pragma: no cover
        with page_frame("Yearly Growth", current=PATH):
            ui.label("Yearly aggregation").classes("text-h5")
            with session_scope() as session:
                rows = aggregate(session, monthly=False)
                projection_rows = project_from_session(session, years=10)
            ui.plotly(_figure(rows)).classes("w-full h-[40vh]")
            ui.aggrid(
                {
                    "columnDefs": [
                        {"headerName": "Year", "field": "label", "sortable": True},
                        {
                            "headerName": "Contributions (EUR)",
                            "field": "contributions",
                            "type": "rightAligned",
                        },
                        {
                            "headerName": "Dividends (EUR)",
                            "field": "dividends",
                            "type": "rightAligned",
                        },
                        {
                            "headerName": "Interest (EUR)",
                            "field": "interest",
                            "type": "rightAligned",
                        },
                        {
                            "headerName": "Net flow (EUR)",
                            "field": "net_flow",
                            "type": "rightAligned",
                        },
                        {
                            "headerName": "Closing value (EUR)",
                            "field": "closing_value",
                            "type": "rightAligned",
                        },
                        {
                            "headerName": "Growth %",
                            "field": "growth_pct",
                            "type": "rightAligned",
                        },
                    ],
                    "rowData": to_table_rows(rows),
                    "defaultColDef": {"resizable": True, "sortable": True},
                }
            ).classes("w-full h-[35vh]")

            ui.label("Hypothetical projection (next 10 years)").classes("text-h6 q-mt-md")
            ui.label(
                "Assumes the average historical annual contribution continues, compounded "
                "at the rates below. For planning only — not a forecast."
            ).classes("text-caption opacity-70")
            ui.aggrid(
                {
                    "columnDefs": [
                        {"headerName": "Year", "field": "year"},
                        {
                            "headerName": "Cumulative contribution (EUR)",
                            "field": "contributed",
                            "type": "rightAligned",
                        },
                        *[
                            {
                                "headerName": _scenario_label(rate),
                                "field": f"rate_{rate}",
                                "type": "rightAligned",
                            }
                            for rate in DEFAULT_SCENARIOS
                        ],
                    ],
                    "rowData": projection_table_rows(projection_rows),
                    "defaultColDef": {"resizable": True, "sortable": True},
                }
            ).classes("w-full h-[35vh]")
