"""Holdings page — the full sortable positions table + deep per-holding detail.

The Overview page leads with a compact web-style card per holding; this page is
the desktop-native companion the user asked for: the complete, sortable AG-Grid
table (now including the **% portfolio weight** column that used to sit on the
web app) plus a summary-statistics strip that only makes sense with the screen
real estate of a desktop — best/worst performer, gainers vs losers, the most
concentrated position, weighted expense and the per-currency totals.
"""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service, prices_service
from investment_dashboard.ui.components import (
    deferred,
    empty_state,
    kpi_card,
    page_header,
    section,
)
from investment_dashboard.ui.components.kpi_card import dual_kpi_card
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import (
    aggrid_money_formatter,
    fmt_money,
    fmt_pct,
)
from investment_dashboard.ui.pages._overview_query import (
    HoldingCard,
    build_holding_cards,
    compute_instrument_metrics,
    get_metrics,
    get_positions,
    holding_freshness,
    position_rows,
)
from investment_dashboard.ui.pages.overview import (
    _price_data_warning,
    _zero_value_warning,
)
from investment_dashboard.ui.theme import color_for_signed

PATH = "/holdings"

ZERO = Decimal(0)

#: AG-Grid ``valueFormatter`` (JS expression) rendering a numeric fraction as a
#: signed percentage, e.g. ``0.0455`` -> ``"4.55 %"``; blanks out ``null``.
_PCT_FORMATTER = (
    "value == null ? '' : (value * 100).toLocaleString("
    "undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) + ' %'"
)


def _SIGN_RULES(signed_field: str) -> dict[str, str]:  # noqa: N802 - config-style constant
    """AG-Grid ``cellClassRules`` colouring a cell by the sign of a companion field.

    Colours come from the colourblind-safe ``.inv-cell-pos`` / ``.inv-cell-neg``
    rules in :mod:`investment_dashboard.ui.style`.
    """
    return {
        "inv-cell-pos": f"data.{signed_field} > 0",
        "inv-cell-neg": f"data.{signed_field} < 0",
    }


def _money_column(
    label: str,
    field: str,
    primary: str,
    *,
    sort: str | None = None,
    color_by_sign: bool = False,
) -> dict[str, object]:
    """A single numeric money column for the *display* currency only.

    Binds to the ``{field}_{ccy}_num`` numeric row key so it still sorts by
    value, with a ``valueFormatter`` rendering the number. ``sort`` seeds the
    grid's initial order; ``color_by_sign`` tints the value gain/loss.
    """
    primary = primary.upper()
    numeric_field = f"{field}_{primary.lower()}_num"
    column: dict[str, object] = {
        "headerName": f"{label} ({primary})",
        "field": numeric_field,
        "type": "rightAligned",
        "valueFormatter": aggrid_money_formatter(primary),
        "minWidth": 130,
    }
    if sort is not None:
        column["sort"] = sort
    if color_by_sign:
        column["cellClassRules"] = _SIGN_RULES(numeric_field)
    return column


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


def _weight_column() -> dict[str, object]:
    """The "% of portfolio" weight column (moved here from the web app box).

    Weight is a ratio (currency-independent), so a single column serves both
    display currencies. It opens unsorted but is fully sortable.
    """
    return {
        "headerName": "Weight",
        "field": "weight_num",
        "type": "rightAligned",
        "valueFormatter": _PCT_FORMATTER,
        "minWidth": 100,
    }


def _summary_stat(
    label: str, value: str, *, sub: str | None = None, color: str | None = None
) -> None:
    """A compact KPI card used in the Holdings summary strip."""
    kpi_card(label, value, sub=sub, color=color)


def _holdings_summary(
    cards: list[HoldingCard], *, display_ccy: str, weighted_expense: Decimal | None
) -> None:  # pragma: no cover - UI
    """Render the deep summary-statistics strip above the table.

    Surfaces the portfolio-shape facts that only fit on a desktop: the number of
    holdings, gainers vs losers, the best and worst performers by total growth,
    the most concentrated position by weight, and the weighted expense ratio.
    """
    ccy = display_ccy.upper()

    def _growth(card: HoldingCard) -> Decimal | None:
        return card.total_growth_eur if ccy == "EUR" else card.total_growth_usd

    rated = [(c, _growth(c)) for c in cards if _growth(c) is not None]
    gainers = sum(1 for _c, g in rated if g is not None and g > 0)
    losers = sum(1 for _c, g in rated if g is not None and g < 0)
    best = max(rated, key=lambda t: t[1], default=None)  # type: ignore[arg-type, return-value]
    worst = min(rated, key=lambda t: t[1], default=None)  # type: ignore[arg-type, return-value]
    heaviest = max(
        (c for c in cards if c.weight is not None),
        key=lambda c: c.weight,  # type: ignore[arg-type, return-value]
        default=None,
    )

    with ui.element("div").classes("inv-kpi-grid w-full"):
        _summary_stat("Holdings", str(len(cards)), sub=f"{gainers} up · {losers} down")
        if best is not None and best[1] is not None:
            _summary_stat(
                "Best performer",
                best[0].symbol,
                sub=f"{fmt_pct(best[1])} total growth",
                color=color_for_signed(float(best[1])),
            )
        if worst is not None and worst[1] is not None:
            _summary_stat(
                "Worst performer",
                worst[0].symbol,
                sub=f"{fmt_pct(worst[1])} total growth",
                color=color_for_signed(float(worst[1])),
            )
        if heaviest is not None and heaviest.weight is not None:
            _summary_stat(
                "Most concentrated",
                heaviest.symbol,
                sub=f"{fmt_pct(heaviest.weight)} of portfolio",
            )
        _summary_stat(
            "Weighted expense",
            fmt_pct(weighted_expense) if weighted_expense is not None else "—",
            sub="annual fund cost",
        )


def register() -> None:
    @ui.page(PATH)
    def _holdings() -> None:  # pragma: no cover - rendered by NiceGUI
        with page_frame("Holdings", current=PATH):
            page_header("Holdings", subtitle="Every position in full detail")

            def _build() -> None:
                with session_scope() as session:
                    metrics = get_metrics(session)
                    positions = get_positions(session)
                    instrument_metrics = compute_instrument_metrics(session, positions)
                    price_anomaly_ids = prices_service.instruments_with_price_anomalies(
                        session, [p.instrument.id for p in positions]
                    )
                    freshness = holding_freshness(session, positions)
                    display_ccy = display_currency_service.get_display_currency(session)
                    usd_rate = display_currency_service.current_rate(session, quote="USD")
                _min_shares = Decimal("0.0000001")
                held_positions = [p for p in positions if p.shares >= _min_shares]
                rows = position_rows(
                    held_positions,
                    display_currency=display_ccy,
                    fx_rate=usd_rate,
                    metrics=instrument_metrics,
                    price_anomaly_ids=price_anomaly_ids,
                    freshness=freshness,
                )
                cards = build_holding_cards(
                    held_positions,
                    metrics=instrument_metrics,
                    freshness=freshness,
                    price_anomaly_ids=price_anomaly_ids,
                )

                if not rows:
                    empty_state(
                        "table_rows",
                        "No positions yet",
                        hint="Go to Transactions → Import CSV to load broker data, "
                        "or seed defaults from Settings.",
                    )
                    return

                # Headline totals carried over so the page stands on its own.
                with ui.element("div").classes("inv-kpi-grid w-full"):
                    dual_kpi_card(
                        "Total Value",
                        fmt_money(metrics.total_value_eur, "EUR"),
                        fmt_money(metrics.total_value_usd, "USD"),
                        primary=display_ccy,
                        tooltip_key="total_value",
                    )
                    dual_kpi_card(
                        "Capital Gain",
                        fmt_money(metrics.capital_gain_eur, "EUR"),
                        fmt_money(metrics.capital_gain_usd, "USD"),
                        primary=display_ccy,
                        tooltip_key="total_gain",
                    )

                _zero_value_warning([c.symbol for c in cards if c.value_warning])
                _price_data_warning([c.symbol for c in cards if c.price_data_warning])

                with section("Portfolio shape"):
                    _holdings_summary(
                        cards,
                        display_ccy=display_ccy,
                        weighted_expense=metrics.weighted_expense_ratio,
                    )

                with section("All holdings"):
                    ccy_key = display_ccy.lower()
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
                                # Price freshness ("as of" the observation date) —
                                # the desktop counterpart to the web app's per-row
                                # "as of" chip.
                                {"headerName": "As Of", "field": "price_as_of"},
                                {
                                    "headerName": "Expense",
                                    "field": "expense_ratio",
                                    "type": "rightAligned",
                                },
                                _money_column("Cost Basis", "cost_basis", display_ccy),
                                _money_column("Value", "value", display_ccy, sort="desc"),
                                # Weight (% of portfolio) — the secondary stat moved
                                # off the web app's holding box and onto the table.
                                _weight_column(),
                                _money_column(
                                    "Capital Gain",
                                    "capital_gain",
                                    display_ccy,
                                    color_by_sign=True,
                                ),
                                _pct_column("Total Growth", "total_growth", display_ccy),
                                _pct_column("XIRR", "xirr", display_ccy),
                                _pct_column("Daily Growth", "daily", display_ccy),
                                _pct_column("YTD Growth", "ytd", display_ccy),
                            ],
                            "rowData": rows,
                            "rowClassRules": {
                                "inv-row-gain": f"data.total_growth_{ccy_key}_signed > 0",
                                "inv-row-loss": f"data.total_growth_{ccy_key}_signed < 0",
                            },
                            "defaultColDef": {
                                "resizable": True,
                                "sortable": True,
                                "flex": 1,
                                "minWidth": 110,
                                "wrapHeaderText": True,
                                "autoHeaderHeight": True,
                            },
                        }
                    ).classes("ag-theme-alpine w-full h-[65vh]")

            deferred(_build)
