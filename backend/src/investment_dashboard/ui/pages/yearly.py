"""Yearly page (spec §8.5) — yearly aggregation table + cumulative growth line."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from nicegui import ui

from investment_dashboard.db import session_scope
from investment_dashboard.services import display_currency_service
from investment_dashboard.ui.components import deferred, page_header, section
from investment_dashboard.ui.layout import page_frame
from investment_dashboard.ui.money_format import currency_symbol
from investment_dashboard.ui.pages._overview_query import ValueSeriesPoint, build_value_series
from investment_dashboard.ui.pages._period_query import (
    PeriodRow,
    aggregate,
    money_column,
    pct_column,
    to_table_rows,
)

PATH = "/yearly"


@dataclass(frozen=True)
class _YearlyData:
    """Everything the yearly body needs, gathered off the event loop."""

    display_ccy: str
    rows: list[PeriodRow]
    value_series: list[ValueSeriesPoint]
    fx_rate: Decimal | None
    value_series_secondary: list[ValueSeriesPoint] | None = None
    secondary_ccy: str | None = None


def _money_columns(label: str, field: str, primary: str) -> list[dict[str, object]]:
    """Single display-currency money column (v2.9.1, one currency at a time)."""
    return [money_column(label, field, primary)]


def _figure(points, *, currency: str, secondary=None, secondary_currency: str | None = None):  # type: ignore[no-untyped-def]
    """Daily portfolio value as a line over the whole history, in display currency.

    The user asked to replace the per-year growth *bars* with a line chart "to
    see how it goes up over time". Plotting one mark per year leaves the line
    badly over-smoothed (a straight segment between year-ends), so we plot the
    **daily** mark-to-market value series instead — the real trajectory. Long
    histories are thinned for rendering speed but keep their shape. The y-axis
    is fitted to the data (not anchored to zero) and uses compact SI ticks so
    the price flow is legible even for large balances.

    ``secondary`` (with ``secondary_currency``) adds a comparison line for the
    *other* currency on a right-hand axis, scaled so both lines share the same
    starting point — matching the Overview value-over-time chart — so the all-time
    graph shows EUR and USD together. The right axis range is the left range
    scaled by ``secondary[0] / primary[0]``, pinning the two opening values to the
    same pixel (and the same zero) so any later gap is purely how the portfolio
    fared in one currency versus the other across the window.
    """
    import plotly.graph_objects as go  # noqa: PLC0415

    from investment_dashboard.ui.charts import downsample, padded_range  # noqa: PLC0415

    symbol = currency_symbol(currency)
    fig = go.Figure()
    has_secondary = False
    if points:
        points = downsample(points)
        dates = [p.date for p in points]
        values = [float(p.value) for p in points]
        fig.add_scatter(
            x=dates,
            y=values,
            mode="lines",
            name=f"In {currency}",
            line={"width": 2.5, "color": "#0072B2"},
            fill="tozeroy",
            fillcolor="rgba(0,114,178,0.08)",
            hovertemplate=(f"%{{x|%d %b %Y}}<br><b>{symbol}%{{y:,.2f}}</b><extra></extra>"),
        )
        # Prepare the optional companion line *before* fitting the value scale so
        # its data can widen that scale and neither line is ever clipped. The two
        # currency lines are linked by a single ``scale`` (right axis = left axis
        # × scale) that pins their two opening values to the same pixel; the left
        # range is fitted to the union of the primary values **and** the companion
        # values mapped back into primary units (companion ÷ scale).
        secondary_plot: tuple[list[object], list[float], float] | None = None
        if secondary and secondary_currency and values and values[0]:
            sec_points = downsample(secondary)
            if len(sec_points) == len(dates):
                sec_dates = [p.date for p in sec_points]
                sec_values = [float(p.value) for p in sec_points]
                if sec_values and sec_values[0] > 0:
                    secondary_plot = (sec_dates, sec_values, sec_values[0] / values[0])
        range_values = [*values]
        if secondary_plot is not None:
            _, sec_values, scale = secondary_plot
            range_values = [*range_values, *(sv / scale for sv in sec_values)]
        yrange = padded_range(range_values)
        fig.update_yaxes(
            title=f"Value ({currency})",
            tickprefix=symbol,
            tickformat=".3s",
            range=list(yrange) if yrange is not None else None,
        )
        # Companion line for the *other* currency on a right-hand axis, scaled so
        # both lines share the same starting point (and the same zero): the right
        # range is the left range times secondary[0]/primary[0]. The left range was
        # already widened above to enclose this line (mapped into primary units),
        # so multiplying it by ``scale`` here keeps *both* lines fully on-screen.
        if secondary_plot is not None and secondary_currency and yrange is not None:
            sec_dates, sec_values, scale = secondary_plot
            sec_symbol = currency_symbol(secondary_currency)
            sec_color = "#CC79A7"  # Wong reddish-purple (colourblind-safe)
            fig.add_scatter(
                x=sec_dates,
                y=sec_values,
                mode="lines",
                name=f"In {secondary_currency}",
                yaxis="y2",
                line={"width": 2, "color": sec_color, "dash": "dot"},
                hovertemplate=(
                    f"<b>{sec_symbol}%{{y:,.2f}}</b> ({secondary_currency})<extra></extra>"
                ),
            )
            fig.update_layout(
                yaxis2={
                    "overlaying": "y",
                    "side": "right",
                    "tickprefix": sec_symbol,
                    "tickformat": ".3s",
                    "separatethousands": True,
                    "showgrid": False,
                    "automargin": True,
                    "range": [yrange[0] * scale, yrange[1] * scale],
                    "tickfont": {"color": sec_color},
                    "title": {
                        "text": secondary_currency,
                        "font": {"color": sec_color},
                    },
                }
            )
            has_secondary = True
    fig.update_layout(
        title=(
            f"Portfolio value over time — {currency} vs {secondary_currency}"
            if has_secondary
            else f"Portfolio value over time ({currency})"
        ),
        template="colorblind_modern",
        margin={"l": 60, "r": 44 if has_secondary else 20, "t": 40, "b": 50},
        xaxis={"title": "Date"},
        showlegend=has_secondary,
        legend=(
            {
                "orientation": "h",
                "yanchor": "bottom",
                "y": 1.02,
                "xanchor": "right",
                "x": 1,
            }
            if has_secondary
            else None
        ),
    )
    return fig


def register() -> None:
    @ui.page(PATH)
    def _yearly() -> None:  # pragma: no cover
        with page_frame("Yearly Growth", current=PATH):
            page_header("Yearly Growth", subtitle="Annual aggregation and growth over time")
            deferred(_build_body, compute=_gather)


def _gather() -> _YearlyData:  # pragma: no cover - heavy DB work, run off-loop
    with session_scope() as session:
        display_ccy = display_currency_service.get_display_currency(session)
        rows = aggregate(session, monthly=False, display_currency=display_ccy)
        value_series = build_value_series(
            session,
            currency=display_ccy,
            range_label="All",
            # The Yearly chart spans the whole portfolio lifetime. Render it
            # from the persistent snapshot cache plus a short fresh tail rather
            # than cold-recomputing thousands of days on the request thread —
            # the background warm keeps the cache complete, and bounding the
            # live recompute here is what stops the page from blocking the event
            # loop (and tripping the reconnect/"crash") when the cache is cold.
            recompute_tail_days=7,
        )
        # Companion line for the *other* currency, so the all-time graph shows
        # EUR and USD side by side like the Overview value-over-time chart. Built
        # from the same range so it lines up point-for-point with the primary;
        # dropped below if it does not (then the chart stays single-currency).
        secondary_ccy: str | None = "USD" if display_ccy.upper() == "EUR" else "EUR"
        value_series_secondary: list[ValueSeriesPoint] | None = build_value_series(
            session,
            currency=secondary_ccy,
            range_label="All",
            recompute_tail_days=7,
        )
        if not value_series_secondary or len(value_series_secondary) != len(value_series):
            value_series_secondary = None
            secondary_ccy = None
        display_quote = display_ccy if display_ccy != "EUR" else "USD"
        fx_rate = display_currency_service.current_rate(session, quote=display_quote)
    return _YearlyData(
        display_ccy=display_ccy,
        rows=rows,
        value_series=value_series,
        fx_rate=fx_rate,
        value_series_secondary=value_series_secondary,
        secondary_ccy=secondary_ccy,
    )


def _build_body(data: _YearlyData) -> None:  # pragma: no cover - heavy render, run after paint
    display_ccy = data.display_ccy
    rows = data.rows
    value_series = data.value_series
    fx_rate = data.fx_rate
    sym = currency_symbol(display_ccy)
    with section("Growth over time"):
        ui.plotly(
            _figure(
                value_series,
                currency=display_ccy,
                secondary=data.value_series_secondary,
                secondary_currency=data.secondary_ccy,
            )
        ).classes(
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
                    # Per-year money-weighted (XIRR) growth, per currency —
                    # consistent with the cumulative Total Growth column.
                    pct_column("Growth % (period)", "yearly_growth", display_ccy),
                    # Total Growth headline metric — kept last (v2.9.1).
                    pct_column("Total Growth", "total_growth", display_ccy),
                ],
                # Table reads newest-first (reverse chronological); the line
                # chart above keeps its natural chronological left-to-right flow.
                "rowData": to_table_rows(
                    list(reversed(rows)), currency=display_ccy, fx_rate=fx_rate
                ),
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
            "prices are missing). Growth % (period) is the per-year money-weighted "
            "(XIRR) return, compounded over the year's own span; for the first "
            "invested year it equals Total Growth by construction. Total Growth (last "
            "column) is cumulative (1 + XIRR) ^ years to the end of the row.",
        ).classes("text-caption opacity-70")
