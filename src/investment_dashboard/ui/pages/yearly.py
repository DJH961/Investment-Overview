"""Yearly page (spec §8.5) — yearly aggregation table + bar chart + projection."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.pages._period_query import aggregate, to_table_rows
from investment_dashboard.ui.pages._projection_query import (
    DEFAULT_SCENARIOS,
    project_from_session,
)
from investment_dashboard.ui.pages._projection_query import (
    to_table_rows as projection_table_rows,
)

PATH = "/yearly"


def _money_columns(label: str, field: str, primary: str) -> list[dict[str, str]]:
    """Build the primary + secondary AG-Grid column pair for one metric.

    The primary column reads the unsuffixed ``field`` key, which the
    :func:`to_table_rows` renderer fills with the FX-aware display-
    currency value when ``aggregate`` was called with that currency
    (v2.2). The secondary column is the EUR ledger value (or USD when
    primary is already EUR, preserving the v1.3 "both visible" toggle).
    """
    primary = primary.upper()
    secondary = "EUR" if primary == "USD" else "USD"
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
    """Yearly Modified-Dietz growth, in the currently selected display currency.

    v2.2's chart stacked contributions + dividends — useful, but the
    same numbers are in the table below. v2.4 replaces it with the
    per-year growth % so the user sees the metric they actually came
    here to see, and so the chart shifts when the EUR ↔ USD toggle
    flips (because each row's ``growth_pct_display`` comes from per-
    trade-date FX in :mod:`_period_query`).
    """
    import plotly.graph_objects as go  # noqa: PLC0415

    fig = go.Figure()
    if rows:
        labels = [r.label for r in rows]
        pct_values: list[float] = []
        for r in rows:
            growth = r.growth_pct_display if r.growth_pct_display is not None else r.growth_pct
            pct_values.append(float(growth) * 100.0 if growth is not None else 0.0)
        colors = ["#0072B2" if v >= 0 else "#E69F00" for v in pct_values]
        fig.add_bar(
            x=labels,
            y=pct_values,
            name="Growth %",
            marker_color=colors,
        )
    fig.update_layout(
        title=f"Yearly growth % ({currency})",
        template="colorblind_modern",
        margin={"l": 40, "r": 20, "t": 40, "b": 40},
        yaxis={"ticksuffix": " %"},
    )
    return fig


def _scenario_label(rate: Decimal) -> str:
    return f"{rate * 100:.1f}% p.a."


def register() -> None:
    @ui.page(PATH)
    def _yearly() -> None:  # pragma: no cover
        with page_frame("Yearly Growth", current=PATH):
            page_header("Yearly Growth", subtitle="Annual aggregation and long-term projection")
            with session_scope() as session:
                display_ccy = display_currency_service.get_display_currency(session)
                rows = aggregate(session, monthly=False, display_currency=display_ccy)
                projection_rows = project_from_session(session, years=10)
                display_quote = display_ccy if display_ccy != "EUR" else "USD"
                fx_rate = display_currency_service.current_rate(session, quote=display_quote)
            with section("Growth per year"):
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

            with section("Hypothetical projection (next 10 years)"):
                ui.label(
                    "Assumes the average historical annual contribution continues, compounded "
                    "at the rates below. For planning only — not a forecast."
                ).classes("text-caption opacity-70")
                ui.aggrid(
                    {
                        "columnDefs": [
                            {"headerName": "Year", "field": "year"},
                            *_money_columns("Cumulative contribution", "contributed", display_ccy),
                            *[
                                col
                                for rate in DEFAULT_SCENARIOS
                                for col in _money_columns(
                                    _scenario_label(rate), f"rate_{rate}", display_ccy
                                )
                            ],
                        ],
                        "rowData": projection_table_rows(
                            projection_rows,
                            currency=display_ccy,
                            fx_rate=fx_rate,
                        ),
                        "defaultColDef": {"resizable": True, "sortable": True},
                    }
                ).classes("ag-theme-alpine w-full h-[50vh]")
