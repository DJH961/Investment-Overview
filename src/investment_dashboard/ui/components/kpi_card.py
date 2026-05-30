"""KPI / metric card — uppercase label, large tabular-num value, hairline border.

Used by the Overview page's top strip (spec §8.1) and reusable elsewhere.

v1.5 cosmetic refresh:

* Uppercase ``inv-kpi-label`` tracking instead of Quasar's ``text-overline``.
* Tabular-num primary value via the shared ``.inv-kpi-value`` rule.
* Optional ``sparkline`` slot — a tiny inline trend renderer; when ``None``
  (the default) the card layout is identical to before and call sites need
  no change.
* Subtle hairline border + soft shadow instead of Quasar's heavy ``shadow-2``.
"""

from __future__ import annotations

from collections.abc import Sequence

from nicegui import ui

from investment_dashboard.ui.components.tooltip_label import label_with_tooltip


def kpi_card(
    label: str,
    value: str,
    *,
    sub: str | None = None,
    tooltip_key: str | None = None,
    color: str | None = None,
    arrow: str | None = None,
    sparkline: Sequence[float] | None = None,
) -> None:
    """Render a single KPI card.

    Args:
        label: short title above the big number.
        value: the primary value, already formatted.
        sub: optional secondary line (e.g. EUR equivalent or % change).
        tooltip_key: a key into :mod:`investment_dashboard.ui.copy.tooltips`.
        color: hex foreground for the value (defaults to theme ink).
        arrow: optional ↑/↓ directional indicator (colorblind redundancy).
        sparkline: optional small sequence of numbers; when provided a tiny
            inline trend chart is drawn at the bottom of the card.
    """
    with ui.element("div").classes("inv-kpi"):
        if tooltip_key:
            label_with_tooltip(label, tooltip_key, classes="inv-kpi-label")
        else:
            ui.html(f'<div class="inv-kpi-label">{label}</div>')
        with ui.row().classes("items-baseline gap-xs no-wrap q-mt-xs"):
            if arrow:
                ui.html(
                    f'<span class="inv-kpi-arrow" style="color: {color or "inherit"}">'
                    f"{arrow}</span>"
                )
            ui.html(
                f'<span class="inv-kpi-value" style="color: {color or "inherit"}">{value}</span>'
            )
        if sub:
            ui.html(f'<div class="inv-kpi-sub">{sub}</div>')
        if sparkline is not None and len(sparkline) > 1:
            _spark(list(sparkline), color=color)


def dual_kpi_card(
    label: str,
    eur_value: str,
    usd_value: str,
    *,
    primary: str = "USD",
    growth_pct: str | None = None,
    tooltip_key: str | None = None,
) -> None:
    """Render a KPI tile that stacks an EUR and USD value equally.

    v2.5 — every monetary KPI on every page renders both currencies
    side by side (never one without the other). ``primary`` decides
    which currency is shown first / larger; the other is shown
    immediately under it, equally weighted (not "main + small grey").

    When ``growth_pct`` is supplied (a pre-formatted percent string —
    typically dual EUR/USD via :func:`dual_pct`) it is rendered as a
    third line, giving Total Growth its prominent position under the
    money value.
    """
    primary = primary.upper()
    first_value, first_ccy, second_value, second_ccy = (
        (usd_value, "USD", eur_value, "EUR")
        if primary != "EUR"
        else (eur_value, "EUR", usd_value, "USD")
    )
    with ui.element("div").classes("inv-kpi"):
        if tooltip_key:
            label_with_tooltip(label, tooltip_key, classes="inv-kpi-label")
        else:
            ui.html(f'<div class="inv-kpi-label">{label}</div>')
        ui.html(
            f'<div class="inv-kpi-value inv-kpi-dual-primary">'
            f'<span class="inv-kpi-dual-ccy">{first_ccy}</span> {first_value}</div>'
        )
        ui.html(
            f'<div class="inv-kpi-dual-secondary">'
            f'<span class="inv-kpi-dual-ccy">{second_ccy}</span> {second_value}</div>'
        )
        if growth_pct is not None:
            ui.html(f'<div class="inv-kpi-growth">{growth_pct}</div>')


def dual_pct_kpi_card(
    label: str,
    primary_value: str,
    secondary_value: str,
    *,
    primary_ccy: str,
    secondary_ccy: str,
    tooltip_key: str | None = None,
    color: str | None = None,
    arrow: str | None = None,
    sub: str | None = None,
) -> None:
    """Render a percentage KPI with a large primary and a smaller secondary.

    Used for return metrics that have an EUR and a USD figure (XIRR, Total
    Growth, YTD, MTD, Daily). The primary-currency percentage gets the big,
    coloured ``inv-kpi-value`` treatment with an optional arrow; the
    secondary-currency percentage is rendered underneath at the smaller
    ``inv-kpi-dual-secondary`` size so it reads as secondary rather than
    competing with the headline (the user's "EUR number should be smaller"
    note on the XIRR card).
    """
    with ui.element("div").classes("inv-kpi"):
        if tooltip_key:
            label_with_tooltip(label, tooltip_key, classes="inv-kpi-label")
        else:
            ui.html(f'<div class="inv-kpi-label">{label}</div>')
        with ui.row().classes("items-baseline gap-xs no-wrap q-mt-xs"):
            if arrow:
                ui.html(
                    f'<span class="inv-kpi-arrow" style="color: {color or "inherit"}">'
                    f"{arrow}</span>"
                )
            ui.html(
                f'<span class="inv-kpi-value" style="color: {color or "inherit"}">'
                f'<span class="inv-kpi-dual-ccy">{primary_ccy}</span> {primary_value}</span>'
            )
        ui.html(
            f'<div class="inv-kpi-dual-secondary">'
            f'<span class="inv-kpi-dual-ccy">{secondary_ccy}</span> {secondary_value}</div>'
        )
        if sub:
            ui.html(f'<div class="inv-kpi-sub">{sub}</div>')


def _spark(values: list[float], *, color: str | None) -> None:  # pragma: no cover - UI
    """Render a tiny inline sparkline using Plotly."""
    import plotly.graph_objects as go  # noqa: PLC0415

    fig = go.Figure(
        go.Scatter(
            x=list(range(len(values))),
            y=values,
            mode="lines",
            line={"width": 1.5, "color": color or "#0F4C81"},
            hoverinfo="skip",
        )
    )
    fig.update_layout(
        margin={"l": 0, "r": 0, "t": 0, "b": 0},
        height=36,
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        xaxis={"visible": False},
        yaxis={"visible": False},
        showlegend=False,
    )
    ui.plotly(fig).classes("w-full").style("height:36px;margin-top:6px")
