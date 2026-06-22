"""Analytics page (spec v2.2 phase (c)) — deep-dive risk + attribution.

The page is intentionally self-contained: it builds an
:class:`~investment_dashboard.ui.pages._analytics_query.AnalyticsBundle`
in a single ``session_scope`` and renders KPIs, the equity curve with
a benchmark overlay, and the per-instrument attribution table from
that bundle alone. Nothing here mutates the DB.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import chart_prefs_service, display_currency_service
from investment_dashboard.services.metrics_service import (
    PortfolioMetrics,
    compute_portfolio_metrics,
)
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
    dual_pct,
    fmt_money,
    fmt_pct,
)
from investment_dashboard.ui.pages._analytics_query import (
    AnalyticsBundle,
    build_bundle,
)
from investment_dashboard.ui.theme import (
    arrow_for_signed,
    color_for_signed,
)

PATH = "/analytics"
#: Persisted-preference key for the equity-curve lookback toggle (days).
_ANALYTICS_LOOKBACK_PREF = "analytics_lookback"


@dataclass(frozen=True)
class _AnalyticsData:
    """Everything the analytics body needs, gathered off the event loop."""

    display_ccy: str
    bundle: AnalyticsBundle
    metrics: PortfolioMetrics
    attribution_rate: Decimal | None
    #: Effective lookback (days) actually used — from the query param or, when
    #: absent, the persisted preference. Drives the toggle's selected value.
    lookback_days: int


_LOOKBACKS: tuple[tuple[str, int], ...] = (
    ("1M", 30),
    ("3M", 91),
    ("6M", 182),
    ("1Y", 365),
    ("3Y", 365 * 3),
    ("5Y", 365 * 5),
)


def _fmt_ratio(value: Decimal | None) -> str:
    if value is None:
        return "—"
    return f"{value:,.2f}"


@contextmanager
def _kpi_group(title: str) -> Iterator[None]:
    """A captioned, uniform-width grid of KPI cards.

    Replaces the old ragged ``flex-wrap`` rows: every card in the group shares
    one column track (``inv-kpi-grid``), so the risk tiles line up in tidy
    columns instead of a jumble of mismatched sizes.
    """
    ui.html(f'<div class="inv-kpi-group-title">{title}</div>')
    with ui.element("div").classes("inv-kpi-grid w-full"):
        yield


def _curve_figure(bundle: AnalyticsBundle):  # type: ignore[no-untyped-def]
    """Equity curve: portfolio value, net invested (cost basis) and a funded
    benchmark overlay.

    Three comparable lines, all in the display currency:

    * **Portfolio value** — daily mark-to-market.
    * **Net invested** — cumulative external contributions (your cost basis).
      The gap to the portfolio line *is* your profit/loss, so we shade the band
      between the two: green when you're ahead, red when you're under water.
    * **Benchmark (funded)** — the same contribution schedule invested in the
      index, so "did I beat the market?" is an honest, like-for-like read
      instead of a lump sum that flatters a dollar-cost-averaged portfolio.
    """
    import plotly.graph_objects as go  # noqa: PLC0415

    from investment_dashboard.ui.charts import downsample  # noqa: PLC0415
    from investment_dashboard.ui.money_format import currency_symbol  # noqa: PLC0415

    fig = go.Figure()
    if not bundle.curve:
        fig.update_layout(
            title=f"Equity curve ({bundle.currency})",
            template="colorblind_modern",
        )
        return fig

    curve = downsample(list(bundle.curve))
    dates = [p.date for p in curve]
    values = [float(p.portfolio_value) for p in curve]
    contribs = [float(p.cumulative_contributions) for p in curve]

    # Net invested (cost basis) — only meaningful when contributions are logged.
    has_contribs = bool(contribs) and (
        max(contribs) - min(contribs) > 1e-6 or abs(contribs[-1]) > 1e-6
    )
    if has_contribs:
        # Draw the invested baseline first, then the portfolio line filling down
        # to it, so the shaded band reads as profit (above) / loss (below).
        fig.add_trace(
            go.Scatter(
                x=dates,
                y=contribs,
                mode="lines",
                name="Net invested",
                line={"width": 1.4, "dash": "dash", "color": "#6c7a89"},
                hovertemplate="%{x|%d %b %Y}<br>Invested: %{y:,.0f}<extra></extra>",
            )
        )
        ahead = values[-1] >= contribs[-1]
        band = "rgba(0,150,80,0.10)" if ahead else "rgba(200,60,40,0.10)"
        fig.add_trace(
            go.Scatter(
                x=dates,
                y=values,
                mode="lines",
                name="Portfolio",
                line={"width": 2.4, "color": "#0072B2"},
                fill="tonexty",
                fillcolor=band,
                hovertemplate="%{x|%d %b %Y}<br>Value: %{y:,.0f}<extra></extra>",
            )
        )
    else:
        fig.add_trace(
            go.Scatter(
                x=dates,
                y=values,
                mode="lines",
                name="Portfolio",
                line={"width": 2.4, "color": "#0072B2"},
                hovertemplate="%{x|%d %b %Y}<br>Value: %{y:,.0f}<extra></extra>",
            )
        )

    # Benchmark overlay. The bundle already funds it with the portfolio's own
    # contributions (``benchmark_is_funded``) and expresses it in the display
    # currency, so it is plotted directly — no rebasing. Older/raw-close callers
    # still get the legacy "rebase to the first portfolio value" lump-sum line.
    bench_pairs = [
        (p.date, p.benchmark_value, p.portfolio_value)
        for p in curve
        if p.benchmark_value is not None
    ]
    if bench_pairs:
        if bundle.benchmark_is_funded:
            bench_x = [d for d, _, _ in bench_pairs]
            bench_y = [float(b) for _, b, _ in bench_pairs]
            bench_name = f"{bundle.benchmark_symbol} (same contributions)"
            fig.add_trace(
                go.Scatter(
                    x=bench_x,
                    y=bench_y,
                    mode="lines",
                    name=bench_name,
                    line={"width": 1.6, "dash": "dot", "color": "#E69F00"},
                    hovertemplate="%{x|%d %b %Y}<br>" + bench_name + ": %{y:,.0f}<extra></extra>",
                )
            )
        else:
            anchor_value = next((v for _, _, v in bench_pairs if v > 0), None)
            anchor_bench = bench_pairs[0][1]
            if anchor_value is not None and anchor_bench is not None and anchor_bench != 0:
                rebased = [(d, float(b / anchor_bench * anchor_value)) for d, b, _ in bench_pairs]
                fig.add_trace(
                    go.Scatter(
                        x=[d for d, _ in rebased],
                        y=[v for _, v in rebased],
                        mode="lines",
                        name=f"Benchmark ({bundle.benchmark_symbol})",
                        line={"width": 1.5, "dash": "dot"},
                    )
                )
    fig.update_xaxes(
        title_text="Date",
        showgrid=True,
        gridcolor="rgba(128,128,128,0.15)",
        showline=True,
        linecolor="rgba(128,128,128,0.4)",
    )
    fig.update_yaxes(
        title_text=f"Value ({bundle.currency})",
        tickprefix=currency_symbol(bundle.currency),
        tickformat=".3s",
        showgrid=True,
        gridcolor="rgba(128,128,128,0.15)",
        showline=True,
        linecolor="rgba(128,128,128,0.4)",
    )
    fig.update_layout(
        title=f"Equity curve ({bundle.currency})",
        template="colorblind_modern",
        margin={"l": 72, "r": 16, "t": 48, "b": 48},
        legend={"orientation": "h", "yanchor": "bottom", "y": 1.02},
        hovermode="x unified",
    )
    return fig


def _render_kpis(
    bundle: AnalyticsBundle,
    *,
    display_ccy: str,
    metrics=None,  # type: ignore[no-untyped-def]
) -> None:
    """KPI cards grouped by concept into uniform-width grids."""
    # v2.5 — Total Growth headline (dual currency) tops every page that
    # reports performance. It now lives in the shared uniform KPI grid as a
    # three-tile hero band (value · growth · gain) instead of a lone card that
    # stretched to the full row width and left a wall of empty space beside it.
    if metrics is not None:
        from investment_dashboard.ui.components.kpi_card import (  # noqa: PLC0415
            dual_pct_kpi_card,
        )

        growth_eur = metrics.total_growth_compounded_eur
        growth_primary = metrics.total_growth_compounded_usd if display_ccy != "EUR" else growth_eur
        with ui.element("div").classes("inv-kpi-grid w-full"):
            dual_kpi_card(
                "Portfolio value",
                fmt_money(metrics.total_value_eur, "EUR"),
                fmt_money(metrics.total_value_usd, "USD"),
                primary=display_ccy,
                tooltip_key="total_value",
            )
            dual_pct_kpi_card(
                "Total Growth",
                fmt_pct(growth_primary),
                fmt_pct(
                    growth_eur if display_ccy != "EUR" else metrics.total_growth_compounded_usd
                ),
                primary_ccy=display_ccy,
                secondary_ccy="EUR" if display_ccy != "EUR" else "USD",
                tooltip_key="total_growth_compounded",
                color=color_for_signed(float(growth_primary or 0)),
                arrow=arrow_for_signed(float(growth_primary or 0)),
            )
            dual_kpi_card(
                "Capital gain",
                fmt_money(metrics.capital_gain_eur, "EUR"),
                fmt_money(metrics.capital_gain_usd, "USD"),
                primary=display_ccy,
                tooltip_key="total_gain",
            )
    with _kpi_group("Returns"):
        kpi_card("CAGR", fmt_pct(bundle.cagr), tooltip_key="cagr")
        kpi_card("TWR", fmt_pct(bundle.twr), tooltip_key="twr")
        kpi_card(
            "XIRR",
            dual_pct(
                metrics.xirr if metrics is not None else bundle.xirr,
                metrics.xirr_usd if metrics is not None else None,
                primary=display_ccy,
            ),
            tooltip_key="xirr",
        )
    with _kpi_group("Risk & volatility"):
        kpi_card(
            "Volatility",
            fmt_pct(bundle.volatility),
            tooltip_key="volatility",
        )
        kpi_card(
            "Sharpe",
            _fmt_ratio(bundle.sharpe),
            tooltip_key="sharpe",
            color=color_for_signed(float(bundle.sharpe or 0)),
            arrow=arrow_for_signed(float(bundle.sharpe or 0)),
        )
        kpi_card(
            "Sortino",
            _fmt_ratio(bundle.sortino),
            tooltip_key="sortino",
            color=color_for_signed(float(bundle.sortino or 0)),
            arrow=arrow_for_signed(float(bundle.sortino or 0)),
        )
        kpi_card("Skew", _fmt_ratio(bundle.skew), tooltip_key="skew")
        kpi_card("Excess Kurtosis", _fmt_ratio(bundle.kurtosis), tooltip_key="kurtosis")
    with _kpi_group("Drawdown & tail risk"):
        kpi_card(
            "Max Drawdown",
            fmt_pct(bundle.max_drawdown),
            tooltip_key="max_drawdown",
            color="#c0392b" if bundle.max_drawdown < 0 else None,
        )
        kpi_card("Calmar", _fmt_ratio(bundle.calmar), tooltip_key="calmar")
        kpi_card("Ulcer Index", fmt_pct(bundle.ulcer), tooltip_key="ulcer")
        kpi_card("VaR (95%)", fmt_pct(bundle.var_95), tooltip_key="var")
        kpi_card("CVaR (95%)", fmt_pct(bundle.cvar_95), tooltip_key="cvar")
    with _kpi_group("Benchmark & market"):
        kpi_card("Beta", _fmt_ratio(bundle.beta), tooltip_key="beta")
        kpi_card("Alpha", fmt_pct(bundle.alpha), tooltip_key="alpha")
        rf_sub = (
            f"source: {bundle.risk_free_symbol}"
            if bundle.risk_free_rate is not None
            else "no live rate cached yet"
        )
        kpi_card(
            "Risk-free rate",
            fmt_pct(bundle.risk_free_rate),
            sub=rf_sub,
            tooltip_key="risk_free",
        )
        kpi_card(
            "Benchmark",
            bundle.benchmark_symbol,
            sub=f"vs. portfolio ({display_ccy})",
            tooltip_key="benchmark",
        )
        # "Did I beat the market?" in money, using the *funded* benchmark (same
        # contributions into the index) so it is a like-for-like comparison.
        if bundle.benchmark_is_funded and bundle.curve:
            last_value = bundle.curve[-1].portfolio_value
            bench_value = next(
                (
                    p.benchmark_value
                    for p in reversed(bundle.curve)
                    if p.benchmark_value is not None
                ),
                None,
            )
            if bench_value is not None:
                diff = last_value - bench_value
                pct = (diff / bench_value) if bench_value > 0 else None
                kpi_card(
                    f"vs {bundle.benchmark_symbol} (funded)",
                    fmt_money(diff, display_ccy),
                    sub=(
                        f"{fmt_pct(pct)} vs same contributions in the index"
                        if pct is not None
                        else "same contributions in the index"
                    ),
                    color=color_for_signed(float(diff)),
                    arrow=arrow_for_signed(float(diff)),
                )


def _fmt_rate(value: Decimal | None) -> str:
    """Format a EUR/USD rate to 4 decimals (``1.0845``), em-dash when unknown."""
    if value is None:
        return "—"
    return f"{value:,.4f}"


def _render_currency_section(metrics, *, display_ccy: str) -> None:  # type: ignore[no-untyped-def]
    """How the EUR ↔ USD rate has helped or hurt this euro-based investor.

    The owner pays in EUR, holds USD assets, and will convert back to EUR — so
    the FX drift between paying in and cashing out is a real gain or loss. This
    band isolates that currency effect from the assets' own performance.
    """
    from investment_dashboard.domain.currency_effect import (  # noqa: PLC0415
        compute_currency_effect,
    )

    effect = compute_currency_effect(
        contributions_eur=metrics.total_contributions_eur,
        contributions_usd=metrics.total_contributions_usd,
        value_eur=metrics.total_value_eur,
        value_usd=metrics.total_value_usd,
        growth_eur=metrics.total_growth_compounded_eur,
        growth_usd=metrics.total_growth_compounded_usd,
    )
    if effect.current_rate is None and effect.avg_invest_rate is None:
        return

    with section("Currency (EUR ↔ USD)"):
        ui.label(
            "You fund in EUR, hold USD assets, and would convert back to EUR — so "
            "the EUR/USD move between paying in and cashing out is its own gain or "
            "loss on top of the assets. A weaker euro (a lower rate) means each "
            "dollar buys back more euros, which is good for you.",
        ).classes("text-caption opacity-70 q-mb-sm")

        with ui.element("div").classes("inv-kpi-grid w-full"):
            kpi_card(
                "EUR/USD now",
                _fmt_rate(effect.current_rate),
                sub=f"avg when you invested: {_fmt_rate(effect.avg_invest_rate)}",
            )
            # A weaker euro (negative rate change) favours a euro investor holding
            # dollars, so colour by favourability (-rate_change), not raw sign.
            if effect.rate_change_pct is not None:
                fav = -float(effect.rate_change_pct)
                weaker = effect.rate_change_pct < 0
                kpi_card(
                    "Euro move since investing",
                    fmt_pct(effect.rate_change_pct),
                    sub=(
                        "euro weaker → tailwind for you" if weaker else "euro stronger → headwind"
                    ),
                    color=color_for_signed(fav),
                    arrow=arrow_for_signed(fav),
                )
            if effect.currency_effect_pp is not None:
                kpi_card(
                    "Currency effect on return",
                    fmt_pct(effect.currency_effect_pp),
                    sub="your EUR return minus your USD return",
                    color=color_for_signed(float(effect.currency_effect_pp)),
                    arrow=arrow_for_signed(float(effect.currency_effect_pp)),
                    tooltip_key="total_growth_compounded",
                )
            if effect.fx_pnl_eur is not None:
                kpi_card(
                    "FX gain / loss (EUR)",
                    fmt_money(effect.fx_pnl_eur, "EUR"),
                    sub="vs investing at your average rate",
                    color=color_for_signed(float(effect.fx_pnl_eur)),
                    arrow=arrow_for_signed(float(effect.fx_pnl_eur)),
                )
            if effect.repatriation_value_eur is not None:
                usd_note = (
                    f"= {fmt_money(metrics.total_value_usd, 'USD')} at "
                    f"{_fmt_rate(effect.current_rate)}"
                    if metrics.total_value_usd is not None and effect.current_rate is not None
                    else "convert the whole portfolio back to EUR"
                )
                kpi_card(
                    "If you transfer back now",
                    fmt_money(effect.repatriation_value_eur, "EUR"),
                    sub=usd_note,
                )


def _attribution_rows(
    bundle: AnalyticsBundle, *, rate: Decimal | None
) -> list[dict[str, str | float]]:
    """Attribution rows in the display currency.

    The underlying :class:`AttributionRow` values are in EUR; ``rate`` is the
    EUR→display-currency factor (``None`` ⇒ show EUR unconverted). All monetary
    columns are scaled by the same factor so the relative attribution — and the
    ``% of total return`` column — is unchanged by the currency switch.
    """
    factor = rate if rate is not None else Decimal(1)
    return [
        {
            "symbol": r.symbol,
            "start_value": float(r.start_value * factor),
            "end_value": float(r.end_value * factor),
            "net_contribution": float(r.net_contribution * factor),
            "absolute_pnl": float(r.absolute_pnl * factor),
            "pct_of_total_return": (
                float(r.pct_of_total_return * Decimal(100))
                if r.pct_of_total_return is not None
                else 0.0
            ),
        }
        for r in bundle.attribution
    ]


def _attribution_totals(
    rows: list[dict[str, str | float]],
) -> dict[str, str | float]:
    """A pinned totals row that ties the per-instrument P&L back to the headline.

    Sums every monetary column across ``rows`` so the table foots to the
    portfolio's own P&L for the window; the ``% of return`` total is the sum of
    the per-instrument shares (≈ 100 % of the window return, modulo rounding).
    """

    def _sum(field: str) -> float:
        return float(sum(float(r.get(field, 0.0) or 0.0) for r in rows))

    return {
        "symbol": "Total",
        "start_value": _sum("start_value"),
        "end_value": _sum("end_value"),
        "net_contribution": _sum("net_contribution"),
        "absolute_pnl": _sum("absolute_pnl"),
        "pct_of_total_return": _sum("pct_of_total_return"),
    }


def _on_lookback_change(days: int) -> None:  # pragma: no cover - UI callback
    with session_scope() as session:
        chart_prefs_service.set_pref(session, _ANALYTICS_LOOKBACK_PREF, str(days))
    ui.navigate.to(f"{PATH}?lookback={days}")


def _parse_lookback(raw: str | None) -> int:
    try:
        v = int(raw) if raw is not None else 365
    except ValueError:
        v = 365
    return max(7, min(v, 365 * 10))


def register() -> None:
    @ui.page(PATH)
    def _analytics(lookback: str | None = None) -> None:  # pragma: no cover - rendered
        with page_frame("Analytics", current=PATH):
            page_header(
                "Analytics",
                subtitle="Risk, attribution, benchmark comparison",
            )

            def _gather() -> _AnalyticsData:
                # Heavy bundle/metrics work runs off the event loop so the
                # websocket stays responsive while it crunches.
                with session_scope() as session:
                    # No explicit query param ⇒ use the last lookback the user
                    # picked (persisted), so the selection sticks across visits.
                    raw_lookback = lookback
                    if raw_lookback is None:
                        raw_lookback = chart_prefs_service.get_pref(
                            session, _ANALYTICS_LOOKBACK_PREF, default="365"
                        )
                    days = _parse_lookback(raw_lookback)
                    display_ccy = display_currency_service.get_display_currency(session)
                    bundle = build_bundle(session, currency=display_ccy, lookback_days=days)
                    metrics = compute_portfolio_metrics(session)
                    attribution_rate = (
                        display_currency_service.current_rate(
                            session, quote=display_ccy, as_of=bundle.as_of
                        )
                        if display_ccy != "EUR"
                        else None
                    )
                return _AnalyticsData(
                    display_ccy=display_ccy,
                    bundle=bundle,
                    metrics=metrics,
                    attribution_rate=attribution_rate,
                    lookback_days=days,
                )

            def _build(data: _AnalyticsData) -> None:
                display_ccy = data.display_ccy
                bundle = data.bundle
                metrics = data.metrics
                attribution_rate = data.attribution_rate
                with ui.row().classes("items-center gap-sm"):
                    ui.label("Lookback:").classes("text-caption opacity-70")
                    ui.toggle(
                        {d: lbl for lbl, d in _LOOKBACKS},
                        value=data.lookback_days,
                        on_change=lambda e: _on_lookback_change(int(e.value)),
                    ).props("dense unelevated no-caps")
                    ui.label(
                        f"{bundle.start.isoformat()} → {bundle.as_of.isoformat()}",
                    ).classes("text-caption opacity-60 q-ml-md")

                _render_kpis(bundle, display_ccy=display_ccy, metrics=metrics)

                with section("Equity curve"):
                    if not bundle.curve:
                        empty_state(
                            "insights",
                            "Not enough history yet",
                            hint="Import some transactions or wait for the daily snapshot to populate.",
                        )
                    else:
                        ui.plotly(_curve_figure(bundle)).classes("w-full").style("height:420px")
                        last = bundle.curve[-1]
                        bench_note = ""
                        if bundle.benchmark_is_funded:
                            bench_val = next(
                                (
                                    p.benchmark_value
                                    for p in reversed(bundle.curve)
                                    if p.benchmark_value is not None
                                ),
                                None,
                            )
                            if bench_val is not None:
                                diff = last.portfolio_value - bench_val
                                verb = "ahead of" if diff >= 0 else "behind"
                                bench_note = (
                                    f" · vs {bundle.benchmark_symbol} (same contributions): "
                                    f"{fmt_money(bench_val, display_ccy)} "
                                    f"({verb} by {fmt_money(abs(diff), display_ccy)})"
                                )
                        ui.label(
                            f"Latest value: {fmt_money(last.portfolio_value, display_ccy)} · "
                            f"net invested: {fmt_money(last.cumulative_contributions, display_ccy)}"
                            f"{bench_note}",
                        ).classes("text-caption opacity-70")

                _render_currency_section(metrics, display_ccy=display_ccy)

                with section("Per-instrument attribution"):
                    rows = _attribution_rows(bundle, rate=attribution_rate)
                    ui.label(
                        "How each holding contributed to the portfolio return over "
                        f"the selected {bundle.start.isoformat()} → {bundle.as_of.isoformat()} "
                        "window — the per-instrument breakdown behind the totals above.",
                    ).classes("text-caption opacity-70 q-mb-sm")
                    if not rows:
                        empty_state(
                            "insights",
                            "No attribution data",
                            hint="Once you hold any instruments for at least the lookback window, "
                            "this table shows each one's contribution to the total return.",
                        )
                    else:
                        totals = _attribution_totals(rows)
                        pnl_rules = {
                            "inv-cell-pos": "data.absolute_pnl > 0",
                            "inv-cell-neg": "data.absolute_pnl < 0",
                        }
                        ui.aggrid(
                            {
                                "columnDefs": [
                                    {
                                        "headerName": "Holding",
                                        "field": "symbol",
                                        "flex": 1.6,
                                        "minWidth": 120,
                                        "pinned": None,
                                    },
                                    {
                                        "headerName": f"Start ({display_ccy})",
                                        "field": "start_value",
                                        "type": "rightAligned",
                                        "valueFormatter": aggrid_money_formatter(display_ccy),
                                    },
                                    {
                                        "headerName": f"End ({display_ccy})",
                                        "field": "end_value",
                                        "type": "rightAligned",
                                        "valueFormatter": aggrid_money_formatter(display_ccy),
                                    },
                                    {
                                        "headerName": f"Net added ({display_ccy})",
                                        "field": "net_contribution",
                                        "type": "rightAligned",
                                        "valueFormatter": aggrid_money_formatter(display_ccy),
                                        "headerTooltip": "Your own buys (+) and sells (-) "
                                        "in the window, excluded from P&L so it isn't "
                                        "double-counted.",
                                    },
                                    {
                                        "headerName": f"P&L ({display_ccy})",
                                        "field": "absolute_pnl",
                                        "type": "rightAligned",
                                        "valueFormatter": aggrid_money_formatter(display_ccy),
                                        "cellClassRules": pnl_rules,
                                        "sort": "desc",
                                    },
                                    {
                                        "headerName": "% of return",
                                        "field": "pct_of_total_return",
                                        "type": "rightAligned",
                                        "minWidth": 110,
                                        "valueFormatter": "value == null ? '' : value.toFixed(1) + ' %'",
                                        "cellClassRules": pnl_rules,
                                    },
                                ],
                                "rowData": rows,
                                # A pinned totals row that ties the per-instrument
                                # P&L back to the portfolio headline.
                                "pinnedBottomRowData": [totals],
                                # Show every instrument (autoHeight grows the grid
                                # to fit all rows) instead of clipping to a fixed
                                # viewport that hid most holdings behind a scrollbar.
                                "domLayout": "autoHeight",
                                "defaultColDef": {
                                    "sortable": True,
                                    "resizable": True,
                                    # Columns flex to fill the width (no horizontal
                                    # scroll / cut-off); a modest minWidth lets them
                                    # shrink on narrow windows rather than overflow.
                                    "flex": 1,
                                    "minWidth": 96,
                                },
                            },
                        ).classes("ag-theme-alpine w-full")
                        ui.label(
                            "P&L is each holding's gain after removing your own buys "
                            "and sells in the window; the rows sum to the portfolio "
                            "total (bottom). Sorted by P&L — winners on top, drags at "
                            "the bottom.",
                        ).classes("text-caption opacity-70 q-mt-xs")

            deferred(_build, compute=_gather)
