"""Overview page (spec §8.1) — KPIs, per-instrument table, allocation treemap."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.ui.components.kpi_card import kpi_card
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.pages._overview_query import (
    allocation_treemap,
    get_metrics,
    get_positions,
    position_rows,
)
from investment_dashboard.ui.theme import (
    PLOTLY_QUALITATIVE,
    arrow_for_signed,
    color_for_signed,
)

PATH = "/overview"


def _fmt_pct(value: Decimal | None) -> str:
    if value is None:
        return "—"
    return f"{value * Decimal(100):,.2f} %"


def _fmt_eur(value: Decimal | None) -> str:
    if value is None:
        return "—"
    return f"€{value:,.2f}"


def _treemap_figure(data):  # type: ignore[no-untyped-def]
    import plotly.graph_objects as go  # noqa: PLC0415

    if not data:
        return go.Figure().update_layout(title="Allocation by category", template="colorblind")
    fig = go.Figure(
        go.Treemap(
            labels=[d.label for d in data],
            parents=[""] * len(data),
            values=[float(d.value_eur) for d in data],
            textinfo="label+value+percent root",
            marker={"colors": PLOTLY_QUALITATIVE[: len(data)]},
        )
    )
    fig.update_layout(
        title="Allocation by category",
        template="colorblind",
        margin={"l": 0, "r": 0, "t": 40, "b": 0},
    )
    return fig


def register() -> None:
    @ui.page(PATH)
    def _overview() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Overview", current=PATH):
            ui.label("Portfolio at a glance").classes("text-h5")
            with session_scope() as session:
                metrics = get_metrics(session)
                positions = get_positions(session)
            rows = position_rows(positions)
            treemap_data = allocation_treemap(positions)

            gain = metrics.capital_gain_eur
            growth_pct = metrics.total_growth_pct or Decimal(0)
            with ui.row().classes("gap-md flex-wrap"):
                kpi_card(
                    "Total Value",
                    _fmt_eur(metrics.total_value_eur),
                    sub=f"as of {metrics.as_of.isoformat()}",
                    tooltip_key="total_value",
                )
                kpi_card(
                    "Total Gain",
                    _fmt_eur(gain),
                    sub=_fmt_pct(metrics.total_growth_pct),
                    tooltip_key="total_gain",
                    color=color_for_signed(float(growth_pct)),
                    arrow=arrow_for_signed(float(growth_pct)),
                )
                kpi_card(
                    "XIRR",
                    _fmt_pct(metrics.xirr),
                    tooltip_key="xirr",
                    color=color_for_signed(float(metrics.xirr or 0)),
                    arrow=arrow_for_signed(float(metrics.xirr or 0)),
                )
                kpi_card(
                    "YTD Growth",
                    _fmt_pct(metrics.ytd_growth_pct),
                    tooltip_key="ytd_growth",
                    color=color_for_signed(float(metrics.ytd_growth_pct or 0)),
                    arrow=arrow_for_signed(float(metrics.ytd_growth_pct or 0)),
                )
            ui.separator()
            if not rows:
                ui.label(
                    "No positions yet — go to Transactions → Import CSV to load broker data."
                ).classes("text-body2 opacity-70")
            else:
                ui.aggrid(
                    {
                        "columnDefs": [
                            {"headerName": "Symbol", "field": "symbol", "pinned": "left"},
                            {"headerName": "Name", "field": "name"},
                            {"headerName": "Category", "field": "category", "filter": True},
                            {"headerName": "Shares", "field": "shares", "type": "rightAligned"},
                            {
                                "headerName": "Avg Price",
                                "field": "avg_price",
                                "type": "rightAligned",
                            },
                            {
                                "headerName": "Current Price",
                                "field": "current_price",
                                "type": "rightAligned",
                            },
                            {
                                "headerName": "Cost Basis",
                                "field": "cost_basis_native",
                                "type": "rightAligned",
                            },
                            {
                                "headerName": "Value (native)",
                                "field": "current_value_native",
                                "type": "rightAligned",
                            },
                            {
                                "headerName": "Value (EUR)",
                                "field": "current_value_eur",
                                "type": "rightAligned",
                            },
                            {
                                "headerName": "Growth %",
                                "field": "total_growth_pct",
                                "type": "rightAligned",
                            },
                        ],
                        "rowData": rows,
                        "defaultColDef": {"resizable": True, "sortable": True},
                    }
                ).classes("w-full h-[40vh]")
                ui.plotly(_treemap_figure(treemap_data)).classes("w-full h-[40vh]")
