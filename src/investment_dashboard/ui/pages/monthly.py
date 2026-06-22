"""Monthly page (spec §8.4) — period aggregation table + growth bar chart."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import deferred, page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import currency_symbol
from investment_dashboard.ui.pages._period_query import (
    PeriodRow,
    aggregate,
    money_column,
    pct_column,
    to_table_rows,
)

PATH = "/monthly"


@dataclass(frozen=True)
class _MonthlyData:
    """Everything the monthly body needs, gathered off the event loop."""

    display_ccy: str
    rows: list[PeriodRow]
    fx_rate: Decimal | None


def _figure(rows, *, currency: str, fx_rate: Decimal | None):  # type: ignore[no-untyped-def]
    """Monthly Modified-Dietz growth, in the currently selected display currency.

    v2.2's chart plotted monthly contributions, which is data the
    aggregation table already shows row-by-row. v2.4 replaces it with
    the per-month growth % the user actually came here to *see* — the
    same series the rightmost ``Growth %`` column reports, just shown
    as a signed bar chart so months of profit/loss read at a glance.
    Bars are coloured green for positive months and red for negative
    ones; flat / unknown months fall through the chart as a zero bar.

    The series is FX-aware: when the page's display currency is non-EUR
    and ``aggregate`` was given the matching ``display_currency`` it
    will have populated ``growth_pct_display`` per row from per-trade-
    date FX, so this chart automatically shifts with the EUR ↔ USD
    toggle (the whole point of v2.4).
    """
    import plotly.graph_objects as go  # noqa: PLC0415

    fig = go.Figure()
    if rows:
        labels = [r.label for r in rows]
        # Display-currency growth wins; fall back to EUR growth_pct when
        # the FX-aware path didn't run (EUR display or no FX history yet).
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
            hovertemplate="%{x}<br>%{y:.2f} %<extra></extra>",
        )
    fig.update_layout(
        title=f"Monthly growth % ({currency})",
        template="colorblind_modern",
        margin={"l": 40, "r": 20, "t": 40, "b": 40},
        yaxis={"ticksuffix": " %"},
    )
    return fig


def _money_columns(label: str, field: str, primary: str) -> list[dict[str, object]]:
    """Single display-currency money column (v2.9.1).

    The monthly / yearly tables now show **one currency at a time** — the same
    executive decision the overview table adopted — flipping the whole table
    with the header toggle rather than carrying an EUR+USD pair per metric.
    """
    return [money_column(label, field, primary)]


def register() -> None:
    @ui.page(PATH)
    def _monthly() -> None:  # pragma: no cover
        with page_frame("Monthly Growth", current=PATH):
            page_header("Monthly Growth", subtitle="Aggregated cashflows and mark-to-market")
            deferred(_build_body, compute=_gather)


def _gather() -> _MonthlyData:  # pragma: no cover - heavy DB work, run off-loop
    with session_scope() as session:
        display_ccy = display_currency_service.get_display_currency(session)
        rows = aggregate(session, monthly=True, display_currency=display_ccy, fill_gaps=True)
        display_quote = display_ccy if display_ccy != "EUR" else "USD"
        fx_rate = display_currency_service.current_rate(session, quote=display_quote)
    return _MonthlyData(display_ccy=display_ccy, rows=rows, fx_rate=fx_rate)


def _build_body(data: _MonthlyData) -> None:  # pragma: no cover - heavy render, run after paint
    display_ccy = data.display_ccy
    rows = data.rows
    fx_rate = data.fx_rate
    sym = currency_symbol(display_ccy)

    with section("Growth per month"):
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
                    # Period (Modified Dietz) growth, per currency.
                    pct_column("Growth % (period)", "growth_pct", display_ccy),
                    # Total Growth is the headline cumulative metric — kept
                    # last per the v2.9.1 layout request.
                    pct_column("Total Growth", "total_growth", display_ccy),
                ],
                "rowData": to_table_rows(rows, currency=display_ccy, fx_rate=fx_rate),
                "defaultColDef": {
                    "resizable": True,
                    "sortable": True,
                    "wrapHeaderText": True,
                    "autoHeaderHeight": True,
                },
                # One calendar year per page: rows are padded to a
                # contiguous Jan–Dec grid (``fill_gaps``) so each
                # 12-row page is exactly one year.
                "pagination": True,
                "paginationPageSize": 12,
            }
        ).classes("ag-theme-alpine w-full h-[55vh]")
        ui.label(
            f"Values shown in {display_ccy} ({sym}); switch currency from the header "
            "toggle. Closing value is end-of-month mark-to-market (best-effort if "
            "prices are missing). Growth % (period) is the per-month time-weighted "
            "return, chained across daily snapshots (it degrades to a single "
            "Modified-Dietz month when snapshots are sparse); Total Growth (last "
            "column) is cumulative (1 + XIRR) ^ years to the end of the row. Each "
            "page is one calendar year (empty months before your first investment "
            "are padded so years line up).",
        ).classes("text-caption opacity-70")
