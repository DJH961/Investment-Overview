"""Analytics page (spec v2.2 phase (c)) — deep-dive risk + attribution.

The page is intentionally self-contained: it builds an
:class:`~investment_dashboard.ui.pages._analytics_query.AnalyticsBundle`
in a single ``session_scope`` and renders KPIs, the equity curve with
a benchmark overlay, and the per-instrument attribution table from
that bundle alone. Nothing here mutates the DB.
"""

from __future__ import annotations

from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.services.metrics_service import compute_portfolio_metrics
from investment_dashboard.ui.components import (
    empty_state,
    kpi_card,
    page_header,
    section,
)
from investment_dashboard.ui.components.kpi_card import dual_kpi_card
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import aggrid_money_formatter, dual_pct, fmt_money
from investment_dashboard.ui.pages._analytics_query import (
    AnalyticsBundle,
    build_bundle,
)
from investment_dashboard.ui.theme import (
    arrow_for_signed,
    color_for_signed,
)

PATH = "/analytics"

_LOOKBACKS: tuple[tuple[str, int], ...] = (
    ("1M", 30),
    ("3M", 91),
    ("6M", 182),
    ("1Y", 365),
    ("3Y", 365 * 3),
    ("5Y", 365 * 5),
)


def _fmt_pct(value: Decimal | None) -> str:
    if value is None:
        return "—"
    return f"{value * Decimal(100):,.2f} %"


def _fmt_ratio(value: Decimal | None) -> str:
    if value is None:
        return "—"
    return f"{value:,.2f}"


def _curve_figure(bundle: AnalyticsBundle):  # type: ignore[no-untyped-def]
    """Equity curve + cumulative-contributions + (rebased) benchmark overlay."""
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

    fig.add_trace(
        go.Scatter(
            x=dates,
            y=values,
            mode="lines",
            name="Portfolio",
            line={"width": 2.4},
        )
    )
    fig.add_trace(
        go.Scatter(
            x=dates,
            y=contribs,
            mode="lines",
            name="Cumulative contributions",
            line={"width": 1.5, "dash": "dash"},
        )
    )
    # Rebase the benchmark to the first non-zero portfolio value so the
    # two lines start at the same point and the overlay reads as a
    # "what if I'd bought VT instead?" curve.
    bench_pairs = [
        (p.date, p.benchmark_value, p.portfolio_value)
        for p in curve
        if p.benchmark_value is not None
    ]
    if bench_pairs:
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
    fig.update_yaxes(tickprefix=currency_symbol(bundle.currency), tickformat=".3s")
    fig.update_layout(
        title=f"Equity curve ({bundle.currency})",
        template="colorblind_modern",
        margin={"l": 0, "r": 0, "t": 40, "b": 0},
        legend={"orientation": "h", "yanchor": "bottom", "y": 1.02},
    )
    return fig


def _render_kpis(
    bundle: AnalyticsBundle,
    *,
    display_ccy: str,
    metrics=None,  # type: ignore[no-untyped-def]
) -> None:
    """Two rows of KPI cards — returns / drawdown / shape."""
    # v2.5 — Total Growth headline (dual currency) tops every page that
    # reports performance.
    if metrics is not None:
        with ui.row().classes("gap-md flex-wrap"):
            dual_kpi_card(
                "Total Growth",
                fmt_money(metrics.total_value_eur, "EUR"),
                fmt_money(metrics.total_value_usd, "USD"),
                primary=display_ccy,
                growth_pct=dual_pct(
                    metrics.total_growth_compounded_eur,
                    metrics.total_growth_compounded_usd,
                    primary=display_ccy,
                ),
                tooltip_key="total_growth_compounded",
            )
    with ui.row().classes("gap-md flex-wrap"):
        kpi_card("CAGR", _fmt_pct(bundle.cagr), tooltip_key="cagr")
        kpi_card("TWR", _fmt_pct(bundle.twr), tooltip_key="twr")
        kpi_card(
            "XIRR",
            dual_pct(
                metrics.xirr if metrics is not None else bundle.xirr,
                metrics.xirr_usd if metrics is not None else None,
                primary=display_ccy,
            ),
            tooltip_key="xirr",
        )
        kpi_card(
            "Volatility",
            _fmt_pct(bundle.volatility),
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
    with ui.row().classes("gap-md flex-wrap"):
        kpi_card(
            "Max Drawdown",
            _fmt_pct(bundle.max_drawdown),
            tooltip_key="max_drawdown",
            color="#c0392b" if bundle.max_drawdown < 0 else None,
        )
        kpi_card("Calmar", _fmt_ratio(bundle.calmar), tooltip_key="calmar")
        kpi_card("Ulcer Index", _fmt_pct(bundle.ulcer), tooltip_key="ulcer")
        kpi_card("VaR (95%)", _fmt_pct(bundle.var_95), tooltip_key="var")
        kpi_card("CVaR (95%)", _fmt_pct(bundle.cvar_95), tooltip_key="cvar")
        kpi_card("Skew", _fmt_ratio(bundle.skew), tooltip_key="skew")
        kpi_card("Excess Kurtosis", _fmt_ratio(bundle.kurtosis), tooltip_key="kurtosis")
    with ui.row().classes("gap-md flex-wrap"):
        kpi_card("Beta", _fmt_ratio(bundle.beta), tooltip_key="beta")
        kpi_card("Alpha", _fmt_pct(bundle.alpha), tooltip_key="alpha")
        rf_sub = (
            f"source: {bundle.risk_free_symbol}"
            if bundle.risk_free_rate is not None
            else "no live rate cached yet"
        )
        kpi_card(
            "Risk-free rate",
            _fmt_pct(bundle.risk_free_rate),
            sub=rf_sub,
            tooltip_key="risk_free",
        )
        kpi_card(
            "Benchmark",
            bundle.benchmark_symbol,
            sub=f"vs. portfolio ({display_ccy})",
            tooltip_key="benchmark",
        )


def _attribution_rows(bundle: AnalyticsBundle) -> list[dict[str, str | float]]:
    return [
        {
            "symbol": r.symbol,
            "start_value": float(r.start_value),
            "end_value": float(r.end_value),
            "net_contribution": float(r.net_contribution),
            "absolute_pnl": float(r.absolute_pnl),
            "pct_of_total_return": (
                float(r.pct_of_total_return * Decimal(100))
                if r.pct_of_total_return is not None
                else 0.0
            ),
        }
        for r in bundle.attribution
    ]


def _on_lookback_change(days: int) -> None:  # pragma: no cover - UI callback
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
        days = _parse_lookback(lookback)
        with page_frame("Analytics", current=PATH):
            page_header(
                "Analytics",
                subtitle="Risk, attribution, benchmark comparison",
            )
            with session_scope() as session:
                display_ccy = display_currency_service.get_display_currency(session)
                bundle = build_bundle(session, currency=display_ccy, lookback_days=days)
                metrics = compute_portfolio_metrics(session)
            with ui.row().classes("items-center gap-sm"):
                ui.label("Lookback:").classes("text-caption opacity-70")
                ui.toggle(
                    {d: lbl for lbl, d in _LOOKBACKS},
                    value=days,
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
                    ui.label(
                        f"Latest value: {fmt_money(last.portfolio_value, display_ccy)} · "
                        f"cumulative contributions: {fmt_money(last.cumulative_contributions, display_ccy)}",
                    ).classes("text-caption opacity-70")

            with section("Per-instrument attribution"):
                rows = _attribution_rows(bundle)
                if not rows:
                    empty_state(
                        "insights",
                        "No attribution data",
                        hint="Once you hold any instruments for at least the lookback window, "
                        "this table shows each one's contribution to the total return.",
                    )
                else:
                    ui.aggrid(
                        {
                            "columnDefs": [
                                {"headerName": "Symbol", "field": "symbol", "pinned": "left"},
                                {
                                    "headerName": "Start value (EUR)",
                                    "field": "start_value",
                                    "type": "rightAligned",
                                    "valueFormatter": aggrid_money_formatter("EUR"),
                                },
                                {
                                    "headerName": "End value (EUR)",
                                    "field": "end_value",
                                    "type": "rightAligned",
                                    "valueFormatter": aggrid_money_formatter("EUR"),
                                },
                                {
                                    "headerName": "Net contribution (EUR)",
                                    "field": "net_contribution",
                                    "type": "rightAligned",
                                    "valueFormatter": aggrid_money_formatter("EUR"),
                                },
                                {
                                    "headerName": "P&L (EUR)",
                                    "field": "absolute_pnl",
                                    "type": "rightAligned",
                                    "valueFormatter": aggrid_money_formatter("EUR"),
                                },
                                {
                                    "headerName": "% of total return",
                                    "field": "pct_of_total_return",
                                    "type": "rightAligned",
                                    "valueFormatter": "value == null ? '' : value.toFixed(2) + ' %'",
                                },
                            ],
                            "rowData": rows,
                            "domLayout": "autoHeight",
                            "defaultColDef": {
                                "sortable": True,
                                "resizable": True,
                                "flex": 1,
                                "minWidth": 130,
                            },
                        },
                    ).classes("w-full")
