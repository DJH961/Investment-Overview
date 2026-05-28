"""Overview page (spec §8.1) — KPIs, per-instrument table, allocation treemap."""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import (
    empty_state,
    kpi_card,
    page_header,
    section,
)
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import fmt_money
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


def _treemap_figure(data, *, currency: str, fx_rate: Decimal | None):  # type: ignore[no-untyped-def]
    import plotly.graph_objects as go  # noqa: PLC0415

    if not data:
        return go.Figure().update_layout(
            title=f"Allocation by category ({currency})",
            template="colorblind_modern",
        )

    def _to_display(value_eur: Decimal) -> float:
        if currency == "EUR" or fx_rate is None or fx_rate == 0:
            return float(value_eur)
        return float(value_eur * fx_rate)

    fig = go.Figure(
        go.Treemap(
            labels=[d.label for d in data],
            parents=[""] * len(data),
            values=[_to_display(d.value_eur) for d in data],
            textinfo="label+value+percent root",
            marker={"colors": PLOTLY_QUALITATIVE[: len(data)]},
        )
    )
    fig.update_layout(
        title=f"Allocation by category ({currency})",
        template="colorblind_modern",
        margin={"l": 0, "r": 0, "t": 40, "b": 0},
    )
    return fig


def register() -> None:
    @ui.page(PATH)
    def _overview() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Overview", current=PATH):
            page_header("Overview", subtitle="Portfolio at a glance")
            with session_scope() as session:
                metrics = get_metrics(session)
                positions = get_positions(session)
                display_ccy = display_currency_service.get_display_currency(session)
                # Display-currency FX (EUR→display). For EUR display we
                # still fetch EUR→USD so the secondary USD column on the
                # positions table stays populated; for USD/DKK display
                # we use the matching rate so KPIs convert correctly.
                display_quote = display_ccy if display_ccy != "EUR" else "USD"
                fx_rate = display_currency_service.current_rate(session, quote=display_quote)
                usd_rate = (
                    fx_rate
                    if display_quote == "USD"
                    else display_currency_service.current_rate(session, quote="USD")
                )
            # Hide fully-sold instruments from the positions table — anything
            # with a residual share count below 1e-7 (a tenth of a millionth
            # of a share) is effectively zero and just clutters the overview.
            _min_shares = Decimal("0.0000001")
            held_positions = [p for p in positions if p.shares >= _min_shares]
            rows = position_rows(held_positions, display_currency=display_ccy, fx_rate=usd_rate)
            treemap_data = allocation_treemap(positions)

            gain = metrics.capital_gain_eur
            growth_pct = metrics.total_growth_pct or Decimal(0)

            primary_value = _convert(metrics.total_value_eur, display_ccy, fx_rate)
            secondary_ccy = "EUR" if display_ccy != "EUR" else "USD"
            secondary_value = _convert(metrics.total_value_eur, secondary_ccy, fx_rate)
            gain_primary = _convert(gain, display_ccy, fx_rate)
            gain_secondary = _convert(gain, secondary_ccy, fx_rate)

            with ui.row().classes("gap-md flex-wrap"):
                kpi_card(
                    "Total Value",
                    fmt_money(primary_value, display_ccy),
                    sub=(
                        f"{fmt_money(secondary_value, secondary_ccy)} · "
                        f"as of {metrics.as_of.isoformat()}"
                    ),
                    tooltip_key="total_value",
                )
                kpi_card(
                    "Total Gain",
                    fmt_money(gain_primary, display_ccy),
                    sub=(
                        f"{fmt_money(gain_secondary, secondary_ccy)} · "
                        f"{_fmt_pct(metrics.total_growth_pct)}"
                    ),
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
            if fx_rate is not None:
                ui.label(
                    f"FX (EUR→{display_quote}): {fx_rate:,.4f}  ·  "
                    f"Display currency: {display_ccy} (switch from the header toggle)",
                ).classes("text-caption opacity-70")
            if not rows:
                empty_state(
                    "insights",
                    "No positions yet",
                    hint="Go to Transactions → Import CSV to load broker data, "
                    "or seed defaults from Settings.",
                )
            else:
                with section("Positions"):
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
                                    "headerName": "Cost Basis (native)",
                                    "field": "cost_basis_native",
                                    "type": "rightAligned",
                                },
                                {
                                    "headerName": "Value (native)",
                                    "field": "current_value_native",
                                    "type": "rightAligned",
                                },
                                {
                                    "headerName": "Value (USD)",
                                    "field": "current_value_usd",
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
                    ).classes("ag-theme-alpine w-full h-[55vh]")
                with section("Allocation"):
                    ui.plotly(
                        _treemap_figure(treemap_data, currency=display_ccy, fx_rate=fx_rate),
                    ).classes("w-full h-[40vh]")


def _convert(amount_eur: Decimal | None, target: str, fx_rate: Decimal | None) -> Decimal | None:
    """Lightweight EUR→target conversion using a pre-fetched FX rate.

    Avoids re-opening a session per KPI card. Returns ``None`` when the
    input is ``None`` so the formatter renders an em dash.
    """
    if amount_eur is None:
        return None
    if target.upper() == "EUR":
        return amount_eur
    if fx_rate is None or fx_rate == 0:
        return amount_eur
    return amount_eur * fx_rate
