"""Yearly page (spec §8.5) — yearly aggregation table + cumulative growth line."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import currency_symbol
from investment_dashboard.ui.pages._period_query import (
    aggregate,
    money_column,
    pct_column,
    to_table_rows,
)

PATH = "/yearly"


def _money_columns(label: str, field: str, primary: str) -> list[dict[str, object]]:
    """Single display-currency money column (v2.9.1, one currency at a time)."""
    return [money_column(label, field, primary)]


def _figure(rows, *, currency: str, fx_rate: Decimal | None):  # type: ignore[no-untyped-def]
    """Cumulative portfolio value as a line over time, in display currency.

    The user asked to replace the per-year growth *bars* with a line
    chart "to see how it goes up over time" — a full growth-over-time
    trajectory. We plot the end-of-year mark-to-market portfolio value
    (the ``closing_value`` series), which rises as the portfolio grows.
    It is FX-aware: ``closing_value_display`` (per-period-end FX) is
    used when present, otherwise the EUR value is scaled by today's spot.
    """
    import plotly.graph_objects as go  # noqa: PLC0415

    fig = go.Figure()
    if rows:
        labels = [r.label for r in rows]
        values: list[float] = []
        for r in rows:
            if r.closing_value_display is not None:
                value = r.closing_value_display
            elif currency.upper() == "EUR" or fx_rate is None or fx_rate == 0:
                value = r.closing_value_eur
            else:
                value = r.closing_value_eur * fx_rate
            values.append(float(value))
        fig.add_scatter(
            x=labels,
            y=values,
            mode="lines+markers",
            name=f"Portfolio value ({currency})",
            line={"width": 2.5, "color": "#0072B2"},
            marker={"size": 7},
            fill="tozeroy",
            fillcolor="rgba(0,114,178,0.08)",
        )
    fig.update_layout(
        title=f"Portfolio value over time ({currency})",
        template="colorblind_modern",
        margin={"l": 60, "r": 20, "t": 40, "b": 50},
        xaxis={"title": "Year"},
        yaxis={"title": f"Value ({currency})"},
    )
    return fig


def register() -> None:
    @ui.page(PATH)
    def _yearly() -> None:  # pragma: no cover
        with page_frame("Yearly Growth", current=PATH):
            page_header("Yearly Growth", subtitle="Annual aggregation and growth over time")
            with session_scope() as session:
                display_ccy = display_currency_service.get_display_currency(session)
                rows = aggregate(session, monthly=False, display_currency=display_ccy)
                display_quote = display_ccy if display_ccy != "EUR" else "USD"
                fx_rate = display_currency_service.current_rate(session, quote=display_quote)
            sym = currency_symbol(display_ccy)
            with section("Growth over time"):
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
                            # Period (Modified Dietz) growth, per currency.
                            pct_column("Growth % (period)", "growth_pct", display_ccy),
                            # Total Growth headline metric — kept last (v2.9.1).
                            pct_column("Total Growth", "total_growth", display_ccy),
                        ],
                        "rowData": to_table_rows(rows, currency=display_ccy, fx_rate=fx_rate),
                        "defaultColDef": {
                            "resizable": True,
                            "sortable": True,
                            "wrapHeaderText": True,
                            "autoHeaderHeight": True,
                        },
                    }
                ).classes("ag-theme-alpine w-full h-[50vh]")
                ui.label(
                    f"Values shown in {display_ccy} ({sym}); switch currency from the header "
                    "toggle. Closing value is end-of-year mark-to-market (best-effort if "
                    "prices are missing). Growth % (period) is the per-year Modified Dietz "
                    "return; Total Growth (last column) is cumulative (1 + XIRR) ^ years to "
                    "the end of the row.",
                ).classes("text-caption opacity-70")
