"""Yearly page (spec §8.5) — yearly aggregation table + bar chart + projection."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.pages._period_query import aggregate, to_table_rows
from investment_dashboard.ui.pages._projection_view import build_seed
from investment_dashboard.ui.pages._projection_view import render as render_projection
from investment_dashboard.ui.theme import GAIN_COLOR

PATH = "/yearly"


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


def _figure(rows, *, currency: str, fx_rate: Decimal | None):  # type: ignore[no-untyped-def]
    import plotly.graph_objects as go  # noqa: PLC0415

    fig = go.Figure()
    if rows:
        contribs = [
            float(
                r.contributions_display
                if r.contributions_display is not None
                else _convert(r.contributions, currency, fx_rate)
            )
            for r in rows
        ]
        divs = [
            float(
                ((r.dividends_display or Decimal(0)) + (r.interest_display or Decimal(0)))
                if r.dividends_display is not None or r.interest_display is not None
                else _convert(r.dividends + r.interest, currency, fx_rate)
            )
            for r in rows
        ]
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
        template="colorblind_modern",
        barmode="stack",
        margin={"l": 40, "r": 20, "t": 40, "b": 40},
    )
    return fig


def register() -> None:
    @ui.page(PATH)
    def _yearly() -> None:  # pragma: no cover
        with page_frame("Yearly Growth", current=PATH):
            page_header("Yearly Growth", subtitle="Annual aggregation and long-term projection")
            with session_scope() as session:
                display_ccy = display_currency_service.get_display_currency(session)
                rows = aggregate(session, monthly=False, display_currency=display_ccy)
                display_quote = display_ccy if display_ccy != "EUR" else "USD"
                fx_rate = display_currency_service.current_rate(session, quote=display_quote)
                projection_seed = build_seed(
                    session, monthly=False, currency=display_ccy, fx_rate=fx_rate
                )
            with section("Cashflows per year"):
                ui.plotly(_figure(rows, currency=display_ccy, fx_rate=fx_rate)).classes(
                    "w-full h-[40vh]",
                )
            with section("Aggregation table"):
                ui.aggrid(
                    {
                        "columnDefs": [
                            {"headerName": "Year", "field": "label", "sortable": True},
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
                    }
                ).classes("ag-theme-alpine w-full h-[50vh]")

            with section("Projection"):
                render_projection(projection_seed)
