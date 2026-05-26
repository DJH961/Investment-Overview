"""Monthly page (spec §8.4) — period aggregation table + bar chart."""

from __future__ import annotations

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.pages._period_query import aggregate, to_table_rows
from investment_dashboard.ui.theme import GAIN_COLOR

PATH = "/monthly"


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
    fig.update_layout(
        title="Monthly contributions (EUR)",
        template="colorblind",
        margin={"l": 40, "r": 20, "t": 40, "b": 40},
    )
    return fig


def register() -> None:
    @ui.page(PATH)
    def _monthly() -> None:  # pragma: no cover
        with page_frame("Monthly Growth", current=PATH):
            ui.label("Monthly aggregation").classes("text-h5")
            with session_scope() as session:
                rows = aggregate(session, monthly=True)
            ui.plotly(_figure(rows)).classes("w-full h-[35vh]")
            ui.aggrid(
                {
                    "columnDefs": [
                        {"headerName": "Month", "field": "label", "sortable": True},
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
                    ],
                    "rowData": to_table_rows(rows),
                    "defaultColDef": {"resizable": True, "sortable": True},
                    "pagination": True,
                    "paginationAutoPageSize": True,
                }
            ).classes("w-full h-[40vh]")
            ui.label(
                "Closing value is end-of-month mark-to-market in EUR (best-effort if prices "
                "are missing for that date)."
            ).classes("text-caption opacity-70")
