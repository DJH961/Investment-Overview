"""Yearly page (spec §8.5) — yearly aggregation table + bar chart + projection."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
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


def _convert(amount_eur: Decimal, target: str, fx_rate: Decimal | None) -> Decimal:
    if target == "EUR" or fx_rate is None or fx_rate == 0:
        return amount_eur
    return amount_eur * fx_rate


def _figure(rows, *, currency: str, fx_rate: Decimal | None):  # type: ignore[no-untyped-def]
    import plotly.graph_objects as go  # noqa: PLC0415

    fig = go.Figure()
    if rows:
        contribs = [float(_convert(r.contributions, currency, fx_rate)) for r in rows]
        divs = [float(_convert(r.dividends + r.interest, currency, fx_rate)) for r in rows]
        fig.add_bar(
            x=[r.label for r in rows],
            y=contribs,
            name="Contributions",
            marker_color=GAIN_COLOR,
        )
        fig.add_bar(
            x=[r.label for r in rows],
            y=divs,
            name="Dividends + Interest",
        )
    fig.update_layout(
        title=f"Yearly cashflows ({currency})",
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
                display_ccy = display_currency_service.get_display_currency(session)
                fx_rate = display_currency_service.current_rate(session, quote="USD")
            ui.plotly(_figure(rows, currency=display_ccy, fx_rate=fx_rate)).classes(
                "w-full h-[40vh]",
            )
            ui.aggrid(
                {
                    "columnDefs": [
                        {"headerName": "Year", "field": "label", "sortable": True},
                        {
                            "headerName": f"Contributions ({display_ccy})",
                            "field": "contributions",
                            "type": "rightAligned",
                        },
                        {
                            "headerName": f"Dividends ({display_ccy})",
                            "field": "dividends",
                            "type": "rightAligned",
                        },
                        {
                            "headerName": f"Interest ({display_ccy})",
                            "field": "interest",
                            "type": "rightAligned",
                        },
                        {
                            "headerName": f"Net flow ({display_ccy})",
                            "field": "net_flow",
                            "type": "rightAligned",
                        },
                        {
                            "headerName": f"Closing value ({display_ccy})",
                            "field": "closing_value",
                            "type": "rightAligned",
                        },
                        {
                            "headerName": "Growth %",
                            "field": "growth_pct",
                            "type": "rightAligned",
                        },
                    ],
                    "rowData": to_table_rows(rows, currency=display_ccy, fx_rate=fx_rate),
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
                            "headerName": f"Cumulative contribution ({display_ccy})",
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
                    "rowData": projection_table_rows(
                        projection_rows,
                        currency=display_ccy,
                        fx_rate=fx_rate,
                    ),
                    "defaultColDef": {"resizable": True, "sortable": True},
                }
            ).classes("w-full h-[35vh]")
