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
