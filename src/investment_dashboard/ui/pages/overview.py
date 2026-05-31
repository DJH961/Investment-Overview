"""Overview page (spec §8.1) — KPIs, per-instrument table, allocation treemap."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import (
    empty_state,
    kpi_card,
    page_header,
    section,
)
from investment_dashboard.ui.components.kpi_card import dual_kpi_card, dual_pct_kpi_card
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import fmt_money
from investment_dashboard.ui.pages._overview_query import (
    VALUE_RANGES,
    MarketVerdict,
    allocation_treemap,
    build_value_series,
    compute_instrument_metrics,
    compute_market_verdict,
    get_metrics,
    get_positions,
    position_rows,
    resolve_range_days,
)
from investment_dashboard.ui.theme import (
    GAIN_COLOR,
    LOSS_COLOR,
    PLOTLY_QUALITATIVE,
    arrow_for_signed,
    color_for_signed,
)

PATH = "/overview"


def _fmt_pct(value: Decimal | None) -> str:
    if value is None:
        return "—"
    return f"{value * Decimal(100):,.2f} %"


def _pct_card(
    label: str,
    eur_pct: Decimal | None,
    usd_pct: Decimal | None,
    *,
    display_ccy: str,
    tooltip_key: str | None = None,
    sub: str | None = None,
) -> None:
    """Render a return KPI with the display currency large and the other small.

    Picks which of (EUR, USD) is primary from ``display_ccy`` and colours /
    arrows the primary figure by its sign, so e.g. when USD is selected the
    EUR percentage is shown as the smaller secondary line.
    """
    primary = display_ccy.upper()
    if primary == "EUR":
        primary_pct, primary_ccy, secondary_pct, secondary_ccy = eur_pct, "EUR", usd_pct, "USD"
    else:
        primary_pct, primary_ccy, secondary_pct, secondary_ccy = usd_pct, "USD", eur_pct, "EUR"
    dual_pct_kpi_card(
        label,
        _fmt_pct(primary_pct),
        _fmt_pct(secondary_pct),
        primary_ccy=primary_ccy,
        secondary_ccy=secondary_ccy,
        tooltip_key=tooltip_key,
        color=color_for_signed(float(primary_pct or 0)),
        arrow=arrow_for_signed(float(primary_pct or 0)),
        sub=sub,
    )


#: AG-Grid ``valueFormatter`` (JS expression) rendering a numeric fraction as a
#: signed percentage, e.g. ``0.0455`` -> ``"4.55 %"``; blanks out ``null``.
_PCT_FORMATTER = (
    "params.value == null ? '' : (params.value * 100).toLocaleString("
    "undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + ' %'"
)

#: AG-Grid ``valueFormatter`` (JS expression) rendering a numeric money value
#: with thousands separators and two decimals; blanks out ``null``.
_MONEY_FORMATTER = (
    "params.value == null ? '' : params.value.toLocaleString("
    "undefined,{minimumFractionDigits:2,maximumFractionDigits:2})"
)


def _money_column(label: str, field: str, primary: str) -> dict[str, object]:
    """A single numeric money column for the *display* currency only.

    The user's executive decision (v2.8.2): show one currency at a time and
    flip the whole table with the header toggle, rather than doubling every
    money column. The column binds to the ``{field}_{ccy}_num`` numeric row key
    so it still sorts by value, and a ``valueFormatter`` renders the number.
    """
    primary = primary.upper()
    return {
        "headerName": f"{label} ({primary})",
        "field": f"{field}_{primary.lower()}_num",
        "type": "rightAligned",
        "valueFormatter": _MONEY_FORMATTER,
        "minWidth": 130,
    }


def _pct_column(label: str, base_field: str, primary: str) -> dict[str, object]:
    """A single percentage column for the display currency, coloured by sign."""
    primary = primary.upper()
    field = f"{base_field}_{primary.lower()}_signed"
    return {
        "headerName": f"{label} ({primary})",
        "field": field,
        "type": "rightAligned",
        "valueFormatter": _PCT_FORMATTER,
        "cellClassRules": _SIGN_RULES(field),
        "minWidth": 120,
    }


def _SIGN_RULES(signed_field: str) -> dict[str, str]:  # noqa: N802 - config-style constant
    """AG-Grid ``cellClassRules`` colouring a cell by the sign of a companion field.

    ``signed_field`` is a numeric field on the row (e.g. ``xirr_signed``)
    that carries the raw float; the visible field stays a formatted string.
    Colours come from the colorblind-safe ``.inv-cell-pos`` / ``.inv-cell-neg``
    rules in :mod:`investment_dashboard.ui.style`.
    """
    return {
        "inv-cell-pos": f"data.{signed_field} > 0",
        "inv-cell-neg": f"data.{signed_field} < 0",
    }


def _verdict_card(verdict: MarketVerdict) -> None:
    """KPI card form of the spreadsheet's "Beating / Losing the market" cell."""
    if verdict.beating is None:
        kpi_card(
            "Vs Market",
            "—",
            sub=f"Need {verdict.benchmark_symbol} history to compare",
            tooltip_key="market_verdict",
        )
        return
    headline = "Beating the market" if verdict.beating else "Trailing the market"
    color = GAIN_COLOR if verdict.beating else LOSS_COLOR
    arrow = arrow_for_signed(1.0 if verdict.beating else -1.0)
    kpi_card(
        "Vs Market",
        headline,
        sub=(
            f"You {_fmt_pct(verdict.portfolio_return)} · "
            f"{verdict.benchmark_symbol} {_fmt_pct(verdict.benchmark_return)}"
        ),
        tooltip_key="market_verdict",
        color=color,
        arrow=arrow,
    )


def _treemap_figure(data, *, currency: str, fx_rate: Decimal | None):  # type: ignore[no-untyped-def]
    import plotly.graph_objects as go  # noqa: PLC0415

    if not data:
        return go.Figure().update_layout(
            title=f"Allocation by category ({currency})",
            template="colorblind_modern",
        )

    def _to_display(value_eur: Decimal) -> float:
        raw = (
            value_eur
            if currency == "EUR" or fx_rate is None or fx_rate == 0
            else value_eur * fx_rate
        )
        # Round to the cent so the treemap's value labels read cleanly
        # (the user's "numbers should be rounded to cent" note).
        return float(raw.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

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


def _value_curve_figure(points, *, currency: str):  # type: ignore[no-untyped-def]
    """Classic portfolio-value line graph over the selected time range."""
    import plotly.graph_objects as go  # noqa: PLC0415

    fig = go.Figure()
    if points:
        fig.add_trace(
            go.Scatter(
                x=[p.date for p in points],
                y=[float(p.value) for p in points],
                mode="lines",
                name=f"Portfolio value ({currency})",
                line={"width": 2.4, "color": GAIN_COLOR},
                fill="tozeroy",
            )
        )
    fig.update_layout(
        title=f"Portfolio value over time ({currency})",
        template="colorblind_modern",
        margin={"l": 0, "r": 0, "t": 40, "b": 0},
        yaxis={"title": currency},
        showlegend=False,
    )
    return fig


def _on_value_range_change(label: str) -> None:  # pragma: no cover - UI callback
    ui.navigate.to(f"{PATH}?value_range={label}")


def _value_over_time_section(value_series, *, range_label, display_ccy):  # type: ignore[no-untyped-def]
    """Render the value-over-time line chart + Day/Month/Year/All selector."""
    with section("Value over time"):
        with ui.row().classes("items-center gap-sm"):
            ui.label("Range:").classes("text-caption opacity-70")
            ui.toggle(
                [name for name, _ in VALUE_RANGES],
                value=range_label,
                on_change=lambda e: _on_value_range_change(str(e.value)),
            ).props("dense unelevated no-caps")
        if not value_series:
            empty_state(
                "show_chart",
                "No value history yet",
                hint="Import transactions or wait for the daily snapshot to populate.",
            )
        else:
            ui.plotly(_value_curve_figure(value_series, currency=display_ccy)).classes(
                "w-full"
            ).style("height:360px")


def register() -> None:
    @ui.page(PATH)
    def _overview(value_range: str | None = None) -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Overview", current=PATH):
            page_header("Overview", subtitle="Portfolio at a glance")
            range_label, _ = resolve_range_days(value_range)
            with session_scope() as session:
                metrics = get_metrics(session)
                positions = get_positions(session)
                instrument_metrics = compute_instrument_metrics(session, positions)
                verdict = compute_market_verdict(session, portfolio_return=metrics.total_growth_pct)
                display_ccy = display_currency_service.get_display_currency(session)
                value_series = build_value_series(
                    session, currency=display_ccy, range_label=range_label
                )
                # Display-currency FX (EUR→display). For EUR display we
                # still fetch EUR→USD so the secondary USD column on the
                # positions table stays populated; for USD display
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
            rows = position_rows(
                held_positions,
                display_currency=display_ccy,
                fx_rate=usd_rate,
                metrics=instrument_metrics,
            )
            treemap_data = allocation_treemap(positions)

            # Total Value is the headline money figure; Total Growth shows the
            # compounded (1 + XIRR) ^ years return per currency.
            total_value_eur = metrics.total_value_eur
            total_value_usd = metrics.total_value_usd
            gain_eur = metrics.capital_gain_eur
            gain_usd = metrics.capital_gain_usd
            tg_eur = metrics.total_growth_compounded_eur
            tg_usd = metrics.total_growth_compounded_usd

            with ui.row().classes("gap-md flex-wrap"):
                # Total Value is the headline money figure (shown first).
                dual_kpi_card(
                    "Total Value",
                    fmt_money(total_value_eur, "EUR"),
                    fmt_money(total_value_usd, "USD"),
                    primary=display_ccy,
                    tooltip_key="total_value",
                )
                # Total Growth shows *growth* — the compounded (1+XIRR)^years
                # return per currency — with the capital-gain money as a sub.
                _pct_card(
                    "Total Growth",
                    tg_eur,
                    tg_usd,
                    display_ccy=display_ccy,
                    tooltip_key="total_growth_compounded",
                    sub=(f"Gain {fmt_money(gain_eur, 'EUR')} / {fmt_money(gain_usd, 'USD')}"),
                )
                dual_kpi_card(
                    "Capital Gain",
                    fmt_money(gain_eur, "EUR"),
                    fmt_money(gain_usd, "USD"),
                    primary=display_ccy,
                    tooltip_key="total_gain",
                )
                _pct_card(
                    "XIRR",
                    metrics.xirr,
                    metrics.xirr_usd,
                    display_ccy=display_ccy,
                    tooltip_key="xirr",
                )
                _pct_card(
                    "YTD Growth",
                    metrics.ytd_growth_pct,
                    metrics.ytd_growth_pct_usd,
                    display_ccy=display_ccy,
                    tooltip_key="ytd_growth",
                )
            with ui.row().classes("gap-md flex-wrap q-mt-md"):
                _daily_sub = (
                    f"as of {metrics.daily_growth_as_of.isoformat()}"
                    if metrics.daily_growth_as_of is not None
                    else "awaiting two priced days"
                )
                _pct_card(
                    "Daily Growth",
                    metrics.daily_growth_pct,
                    metrics.daily_growth_pct_usd,
                    display_ccy=display_ccy,
                    tooltip_key="daily_growth",
                    sub=_daily_sub,
                )
                _pct_card(
                    "MTD Growth",
                    metrics.mtd_growth_pct,
                    metrics.mtd_growth_pct_usd,
                    display_ccy=display_ccy,
                    tooltip_key="mtd_growth",
                )
                kpi_card(
                    "Expense Ratio",
                    _fmt_pct(metrics.weighted_expense_ratio),
                    sub=(
                        f"≈ {fmt_money(_convert(metrics.annual_expense_cost_eur, display_ccy, fx_rate), display_ccy)} / yr"
                    ),
                    tooltip_key="expense_ratio",
                )
                _verdict_card(verdict)
            if fx_rate is not None:
                ui.label(
                    f"FX (EUR→{display_quote}): {fx_rate:,.4f}  ·  "
                    f"Display currency: {display_ccy} (switch from the header toggle)",
                ).classes("text-caption opacity-70")

            _value_over_time_section(value_series, range_label=range_label, display_ccy=display_ccy)

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
                                    "headerName": "Expense",
                                    "field": "expense_ratio",
                                    "type": "rightAligned",
                                },
                                # One currency at a time (the display toggle).
                                _money_column("Cost Basis", "cost_basis", display_ccy),
                                _money_column("Value", "value", display_ccy),
                                _money_column("Capital Gain", "capital_gain", display_ccy),
                                _pct_column("Total Growth", "total_growth", display_ccy),
                                _pct_column("XIRR", "xirr", display_ccy),
                                _pct_column("Daily Growth", "daily", display_ccy),
                                _pct_column("YTD Growth", "ytd", display_ccy),
                            ],
                            "rowData": rows,
                            "defaultColDef": {
                                "resizable": True,
                                "sortable": True,
                                "flex": 1,
                                "minWidth": 110,
                            },
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
