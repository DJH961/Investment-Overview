"""Monthly page (spec §8.4) — period aggregation table + bar chart + projection."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import currency_symbol
from investment_dashboard.ui.pages._period_query import aggregate, to_table_rows
from investment_dashboard.ui.pages._projection_query import (
    DEFAULT_SCENARIOS,
    project_monthly_from_session,
    to_monthly_table_rows,
)
from investment_dashboard.ui.theme import GAIN_COLOR

PATH = "/monthly"


def _figure(rows, *, currency: str, fx_rate: Decimal | None):  # type: ignore[no-untyped-def]
    import plotly.graph_objects as go  # noqa: PLC0415

    fig = go.Figure()
    if rows:
        scaled = [
            float(
                r.contributions_display
                if r.contributions_display is not None
                else _convert(r.contributions, currency, fx_rate)
            )
            for r in rows
        ]
        fig.add_bar(
            x=[r.label for r in rows],
            y=scaled,
            name="Contributions",
            marker_color=GAIN_COLOR,
        )
    fig.update_layout(
        title=f"Monthly contributions ({currency})",
        template="colorblind_modern",
        margin={"l": 40, "r": 20, "t": 40, "b": 40},
    )
    return fig


def _scenario_label(rate: Decimal) -> str:
    return f"{rate * 100:.1f}% p.a."


def _convert(amount_eur: Decimal, target: str, fx_rate: Decimal | None) -> Decimal:
    target = target.upper()
    if target == "EUR" or fx_rate is None or fx_rate == 0:
        return amount_eur
    return amount_eur * fx_rate


def _money_columns(label: str, field: str, primary: str) -> list[dict[str, str]]:
    """Build the primary + secondary AG-Grid column pair for one metric.

    The primary column reads the unsuffixed ``field`` key, which the
    :func:`to_table_rows` renderer fills with the FX-aware display-
    currency value when ``aggregate`` was called with that currency
    (v2.2). The secondary column is the EUR ledger value (or USD when
    primary is already EUR, preserving the v1.3 "both visible" toggle).
    """
    primary = primary.upper()
    secondary = "EUR" if primary in {"USD", "DKK"} else "USD"
    return [
        {
            "headerName": f"{label} ({primary})",
            "field": field,
            "type": "rightAligned",
        },
        {
            "headerName": f"{label} ({secondary})",
            "field": f"{field}_{secondary.lower()}",
            "type": "rightAligned",
        },
    ]


def register() -> None:
    @ui.page(PATH)
    def _monthly() -> None:  # pragma: no cover
        with page_frame("Monthly Growth", current=PATH):
            page_header("Monthly Growth", subtitle="Aggregated cashflows and mark-to-market")
            with session_scope() as session:
                display_ccy = display_currency_service.get_display_currency(session)
                rows = aggregate(session, monthly=True, display_currency=display_ccy)
                projection_rows = project_monthly_from_session(session, months=36)
                display_quote = display_ccy if display_ccy != "EUR" else "USD"
                fx_rate = display_currency_service.current_rate(session, quote=display_quote)
            sym = currency_symbol(display_ccy)
            with section("Contributions per month"):
                ui.plotly(_figure(rows, currency=display_ccy, fx_rate=fx_rate)).classes(
                    "w-full h-[35vh]",
                )
            with section("Aggregation table"):
                ui.aggrid(
                    {
                        "columnDefs": [
                            {"headerName": "Month", "field": "label", "sortable": True},
                            *_money_columns("Contributions", "contributions", display_ccy),
                            *_money_columns("Dividends", "dividends", display_ccy),
                            *_money_columns("Interest", "interest", display_ccy),
                            *_money_columns("Net flow", "net_flow", display_ccy),
                            *_money_columns("Closing value", "closing_value", display_ccy),
                            {
                                "headerName": "Growth %",
                                "field": "growth_pct",
                                "type": "rightAligned",
                            },
                        ],
                        "rowData": to_table_rows(rows, currency=display_ccy, fx_rate=fx_rate),
                        "defaultColDef": {"resizable": True, "sortable": True},
                        "pagination": True,
                        "paginationAutoPageSize": True,
                    }
                ).classes("ag-theme-alpine w-full h-[55vh]")
                ui.label(
                    f"Values shown in {display_ccy} ({sym}). Closing value is end-of-month "
                    "mark-to-market (best-effort if prices are missing). Growth % is "
                    "Modified Dietz over external flows. Use the EUR/USD toggle in the "
                    "header to choose which currency appears first.",
                ).classes("text-caption opacity-70")

            with section("Hypothetical projection (next 36 months)"):
                ui.label(
                    "Assumes the average historical monthly contribution continues, compounded "
                    "at the rates below. For planning only — not a forecast."
                ).classes("text-caption opacity-70")
                ui.aggrid(
                    {
                        "columnDefs": [
                            {"headerName": "Month", "field": "label"},
                            *_money_columns("Cumulative contribution", "contributed", display_ccy),
                            *[
                                col
                                for rate in DEFAULT_SCENARIOS
                                for col in _money_columns(
                                    _scenario_label(rate), f"rate_{rate}", display_ccy
                                )
                            ],
                        ],
                        "rowData": to_monthly_table_rows(
                            projection_rows,
                            currency=display_ccy,
                            fx_rate=fx_rate,
                        ),
                        "defaultColDef": {"resizable": True, "sortable": True},
                        "pagination": True,
                        "paginationAutoPageSize": True,
                    }
                ).classes("ag-theme-alpine w-full h-[50vh]")
