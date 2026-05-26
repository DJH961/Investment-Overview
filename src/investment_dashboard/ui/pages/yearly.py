"""Yearly page (spec §8.5) — yearly aggregation table + bar chart."""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.pages._period_query import aggregate, to_table_rows
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


def register() -> None:
    @ui.page(PATH)
    def _yearly() -> None:  # pragma: no cover
        with page_frame("Yearly Growth", current=PATH):
            ui.label("Yearly aggregation").classes("text-h5")
            with session_scope() as session:
                rows = aggregate(session, monthly=False)
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
                    ],
                    "rowData": to_table_rows(rows),
                    "defaultColDef": {"resizable": True, "sortable": True},
                }
            ).classes("w-full h-[35vh]")
            ui.label("Hypothetical projection block lands in v1.1.").classes(
                "text-caption opacity-70"
            )
