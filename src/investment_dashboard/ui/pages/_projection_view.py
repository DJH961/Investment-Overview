"""Interactive projection tool — shared UI for ``/monthly`` and ``/yearly``.

This module owns the *Projection* section that both period pages render. It
has two responsibilities:

* :func:`build_seed` — a thin DB read that captures the simulation's
  starting point: current portfolio value, the average historical
  contribution for the chosen cadence, and the portfolio's **XIRR** (the
  default "existing performance continues" growth rate).
* :func:`render` — the NiceGUI widget: assumption controls + a Plotly
  outcome cone + KPI cards + goal-seeking callout + a per-period table,
  all recomputed live via :func:`~nicegui.ui.refreshable`.

All heavy math lives in :mod:`._projection_model`; this layer only
captures inputs, converts EUR→display currency, and draws.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from nicegui import ui

from investment_dashboard.ui.components import kpi_card, section
from investment_dashboard.ui.money_format import fmt_money
from investment_dashboard.ui.pages._period_query import aggregate
from investment_dashboard.ui.pages._projection_model import (
    SCENARIO_EXPECTED,
    SCENARIO_OPTIMISTIC,
    SCENARIO_PESSIMISTIC,
    ProjectionParams,
    band_rates,
    default_expected_rate,
    required_contribution,
    simulate,
    time_to_target,
)
from investment_dashboard.ui.theme import GAIN_COLOR

ZERO = Decimal(0)

# Display labels + plot colours for the three scenarios.
_SCENARIO_LABEL = {
    SCENARIO_PESSIMISTIC: "Pessimistic",
    SCENARIO_EXPECTED: "Expected",
    SCENARIO_OPTIMISTIC: "Optimistic",
}


@dataclass(frozen=True)
class ProjectionSeed:
    """Starting point + sensible defaults for the projection controls."""

    monthly: bool
    starting_value_eur: Decimal
    avg_contribution_eur: Decimal
    expected_rate: Decimal  # annual, already sanitised
    xirr_available: bool
    currency: str
    fx_rate: Decimal | None
    today: date

    @property
    def periods_per_year(self) -> int:
        return 12 if self.monthly else 1

    @property
    def default_horizon_years(self) -> int:
        return 10


def _avg_contribution(rows) -> Decimal:  # type: ignore[no-untyped-def]
    """Mean of historical positive contributions (withdrawal-only periods ignored)."""
    contribs = [r.contributions for r in rows if r.contributions > 0]
    if not contribs:
        return ZERO
    return sum(contribs, start=ZERO) / Decimal(len(contribs))


def build_seed(
    session,  # type: ignore[no-untyped-def]
    *,
    monthly: bool,
    currency: str,
    fx_rate: Decimal | None,
    today: date | None = None,
) -> ProjectionSeed:
    """Read live portfolio state and derive the projection's starting point."""
    from investment_dashboard.services import metrics_service, positions_service  # noqa: PLC0415

    today = today or date.today()
    starting = positions_service.total_portfolio_value(session, as_of=today)
    rows = aggregate(session, monthly=monthly, with_closing_value=False, today=today)
    avg_contrib = _avg_contribution(rows)

    metrics = metrics_service.compute_portfolio_metrics(session, as_of=today)
    expected = default_expected_rate(metrics.xirr)

    return ProjectionSeed(
        monthly=monthly,
        starting_value_eur=starting,
        avg_contribution_eur=avg_contrib,
        expected_rate=expected,
        xirr_available=metrics.xirr is not None,
        currency=currency,
        fx_rate=fx_rate,
        today=today,
    )


def _to_display(value_eur: Decimal, currency: str, fx_rate: Decimal | None) -> Decimal:
    """EUR → display currency (identity for EUR or when no rate is cached)."""
    if currency.upper() == "EUR" or fx_rate is None or fx_rate == 0:
        return value_eur
    return value_eur * fx_rate


def _num(value) -> Decimal:  # type: ignore[no-untyped-def]
    """Coerce a NiceGUI number-input value to ``Decimal`` (``0`` on junk)."""
    if value is None:
        return ZERO
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return ZERO


def render(seed: ProjectionSeed) -> None:  # pragma: no cover - UI wiring
    """Render the full interactive projection tool for ``seed``."""
    period_word = "month" if seed.monthly else "year"
    ccy = seed.currency
    fx = seed.fx_rate

    intro = (
        "Starts from your current portfolio value and projects forward. The "
        f"**expected** line grows at your portfolio's historical XIRR "
        f"({seed.expected_rate * 100:.1f}% p.a."
        + ("" if seed.xirr_available else ", default — not enough history for XIRR yet")
        + "); optimistic and pessimistic fan out by the band you choose. "
        "For planning only — not a guarantee."
    )
    ui.markdown(intro).classes("text-caption opacity-70")

    # --- assumption controls -------------------------------------------------
    controls: dict[str, ui.element] = {}
    with ui.row().classes("gap-md items-end flex-wrap q-mb-sm"):
        controls["expected"] = (
            ui.number(
                "Expected return % p.a.",
                value=round(float(seed.expected_rate * 100), 2),
                step=0.5,
                format="%.2f",
            )
            .props("dense outlined")
            .classes("w-40")
        )
        controls["band"] = (
            ui.number("± band (pp)", value=3.0, min=0, step=0.5, format="%.1f")
            .props("dense outlined")
            .classes("w-32")
        )
        controls["contribution"] = (
            ui.number(
                f"Contribution / {period_word} ({ccy})",
                value=round(float(_to_display(seed.avg_contribution_eur, ccy, fx)), 2),
                min=0,
                step=50,
                format="%.2f",
            )
            .props("dense outlined")
            .classes("w-48")
        )
        controls["stepup"] = (
            ui.number("Annual step-up %", value=0.0, min=0, step=1, format="%.1f")
            .props("dense outlined")
            .classes("w-36")
        )
        controls["inflation"] = (
            ui.number("Inflation %", value=2.0, min=0, step=0.5, format="%.1f")
            .props("dense outlined")
            .classes("w-32")
        )
        controls["target"] = (
            ui.number(f"Target value ({ccy})", value=0.0, min=0, step=10000, format="%.0f")
            .props("dense outlined")
            .classes("w-44")
        )

    with ui.row().classes("gap-md items-center flex-wrap q-mb-sm"):
        ui.label(f"Horizon ({period_word}s):").classes("text-caption opacity-70")
        controls["horizon"] = (
            ui.slider(
                min=1,
                max=40 if seed.monthly is False else 480,
                value=seed.default_horizon_years if not seed.monthly else 120,
                step=1,
            )
            .props("label-always")
            .classes("w-64")
        )
        controls["real"] = ui.switch("Show in today's money (real)", value=False)

    # --- live body -----------------------------------------------------------
    @ui.refreshable
    def body() -> None:
        params, target, real = _params_from_controls(seed, controls)
        result = simulate(params)
        _render_kpis(result, target=target, real=real, currency=ccy, fx=fx)
        _render_chart(result, real=real, currency=ccy, fx=fx, period_word=period_word)
        _render_goal(
            params, result, target=target, real=real, currency=ccy, fx=fx, period_word=period_word
        )
        _render_table(result, real=real, currency=ccy, fx=fx, period_word=period_word)

    def _refresh(_event: object = None) -> None:
        body.refresh()

    for element in controls.values():
        element.on_value_change(_refresh)

    body()


def _params_from_controls(
    seed: ProjectionSeed,
    controls: dict[str, ui.element],
) -> tuple[ProjectionParams, Decimal, bool]:
    """Translate live control values into a :class:`ProjectionParams` (EUR base)."""
    expected = _num(controls["expected"].value) / Decimal(100)
    band = _num(controls["band"].value) / Decimal(100)
    stepup = _num(controls["stepup"].value) / Decimal(100)
    inflation = _num(controls["inflation"].value) / Decimal(100)
    horizon = int(_num(controls["horizon"].value))
    real = bool(controls["real"].value)

    # Controls are entered in display currency; the engine works in EUR.
    fx = seed.fx_rate
    rate = fx if (seed.currency.upper() != "EUR" and fx) else Decimal(1)
    contribution_eur = _num(controls["contribution"].value) / (rate or Decimal(1))
    target_display = _num(controls["target"].value)
    target_eur = target_display / (rate or Decimal(1))

    params = ProjectionParams(
        starting_value=seed.starting_value_eur,
        base_contribution=contribution_eur,
        periods=max(horizon, 0),
        periods_per_year=seed.periods_per_year,
        annual_rates=band_rates(expected, band),
        annual_contribution_growth=stepup,
        inflation_rate=inflation,
        start=seed.today,
    )
    return params, target_eur, real


def _series(point, scenario: str, *, real: bool) -> Decimal:  # type: ignore[no-untyped-def]
    return (point.real_by_scenario if real else point.nominal_by_scenario)[scenario]


def _render_kpis(result, *, target, real, currency, fx) -> None:  # type: ignore[no-untyped-def]
    last = result.final
    money_kind = "real" if real else "nominal"
    with ui.row().classes("gap-md flex-wrap q-mt-sm"):
        if last is None:
            kpi_card(
                "Projected value",
                fmt_money(_disp(result.params.starting_value, currency, fx), currency),
            )
            return
        kpi_card(
            "Expected value",
            fmt_money(_disp(_series(last, SCENARIO_EXPECTED, real=real), currency, fx), currency),
            sub=f"{money_kind}, end of horizon",
            tooltip_key="projection_expected",
        )
        kpi_card(
            "Optimistic",
            fmt_money(_disp(_series(last, SCENARIO_OPTIMISTIC, real=real), currency, fx), currency),
            color=GAIN_COLOR,
        )
        kpi_card(
            "Pessimistic",
            fmt_money(
                _disp(_series(last, SCENARIO_PESSIMISTIC, real=real), currency, fx), currency
            ),
            color="#c0392b",
        )
        kpi_card(
            "Total contributed",
            fmt_money(_disp(result.total_contributed, currency, fx), currency),
            sub="new money over horizon",
        )
        expected_final = _series(last, SCENARIO_EXPECTED, real=real)
        gain = expected_final - result.params.starting_value - result.total_contributed
        kpi_card(
            "Projected growth",
            fmt_money(_disp(gain, currency, fx), currency),
            sub="expected, excl. contributions",
            color=GAIN_COLOR if gain >= 0 else "#c0392b",
        )


def _disp(value_eur: Decimal, currency: str, fx: Decimal | None) -> Decimal:
    return _to_display(value_eur, currency, fx)


def _render_chart(result, *, real, currency, fx, period_word) -> None:  # type: ignore[no-untyped-def]
    import plotly.graph_objects as go  # noqa: PLC0415

    fig = go.Figure()
    if result.points:
        x = [p.label for p in result.points]

        def vals(scenario: str) -> list[float]:
            return [
                float(_disp(_series(p, scenario, real=real), currency, fx)) for p in result.points
            ]

        pess, exp, opt = (
            vals(SCENARIO_PESSIMISTIC),
            vals(SCENARIO_EXPECTED),
            vals(SCENARIO_OPTIMISTIC),
        )
        contributed = [
            float(_disp(p.contributed + result.params.starting_value, currency, fx))
            for p in result.points
        ]

        # Shaded cone: pessimistic (lower) then optimistic with fill to it.
        fig.add_trace(
            go.Scatter(
                x=x, y=pess, mode="lines", line={"width": 0}, name="Pessimistic", showlegend=False
            )
        )
        fig.add_trace(
            go.Scatter(
                x=x,
                y=opt,
                mode="lines",
                line={"width": 0},
                fill="tonexty",
                fillcolor="rgba(46,134,193,0.15)",
                name="Outcome range",
            )
        )
        fig.add_trace(go.Scatter(x=x, y=exp, mode="lines", name="Expected", line={"width": 2.6}))
        fig.add_trace(
            go.Scatter(
                x=x,
                y=contributed,
                mode="lines",
                name="Invested (start + contributions)",
                line={"width": 1.4, "dash": "dash", "color": GAIN_COLOR},
            )
        )
    title_kind = "today's money" if real else "nominal"
    fig.update_layout(
        title=f"Projected value over the next {len(result.points)} {period_word}s ({currency}, {title_kind})",
        template="colorblind_modern",
        margin={"l": 0, "r": 0, "t": 40, "b": 0},
        legend={"orientation": "h", "yanchor": "bottom", "y": 1.02},
    )
    ui.plotly(fig).classes("w-full").style("height:420px")


def _fmt_years(years: Decimal) -> str:
    y = float(years)
    if y >= 1:
        return f"{y:.1f} yr"
    return f"{y * 12:.0f} mo"


def _render_goal(  # type: ignore[no-untyped-def]
    params, result, *, target, real, currency, fx, period_word
) -> None:
    if target <= 0:
        return
    target_disp = fmt_money(_disp(target, currency, fx), currency)
    hits = time_to_target(result, target, real=real)
    with ui.card().classes("w-full q-mt-sm").style("background: rgba(46,134,193,0.06)"):
        ui.label(f"🎯 Reaching {target_disp}").classes("text-subtitle2")
        with ui.row().classes("gap-lg flex-wrap"):
            for scenario in (SCENARIO_PESSIMISTIC, SCENARIO_EXPECTED, SCENARIO_OPTIMISTIC):
                hit = hits.get(scenario)
                when = f"{hit.label} ({_fmt_years(hit.years)})" if hit else "not within horizon"
                ui.label(f"{_SCENARIO_LABEL[scenario]}: {when}").classes("text-body2")
        needed = required_contribution(params, target)
        if needed is not None:
            needed_disp = fmt_money(_disp(needed, currency, fx), currency)
            ui.label(
                f"To reach it by the end of the horizon at the expected return, contribute about "
                f"{needed_disp} per {period_word}."
            ).classes("text-caption opacity-80")
        else:
            ui.label(
                "Even large contributions can't reach this target within the horizon — "
                "extend the horizon or raise the expected return."
            ).classes("text-caption opacity-80")


def _render_table(result, *, real, currency, fx, period_word) -> None:  # type: ignore[no-untyped-def]
    rows = []
    for p in result.points:
        rows.append(
            {
                "label": p.label,
                "contributed": float(_disp(p.contributed, currency, fx)),
                "pessimistic": float(
                    _disp(_series(p, SCENARIO_PESSIMISTIC, real=real), currency, fx)
                ),
                "expected": float(_disp(_series(p, SCENARIO_EXPECTED, real=real), currency, fx)),
                "optimistic": float(
                    _disp(_series(p, SCENARIO_OPTIMISTIC, real=real), currency, fx)
                ),
            }
        )
    money_fmt = "params.value.toLocaleString(undefined,{maximumFractionDigits:0})"
    with section(f"Year-by-{period_word} detail"):
        ui.aggrid(
            {
                "columnDefs": [
                    {"headerName": period_word.capitalize(), "field": "label", "pinned": "left"},
                    {
                        "headerName": f"Contributed ({currency})",
                        "field": "contributed",
                        "type": "rightAligned",
                        "valueFormatter": money_fmt,
                    },
                    {
                        "headerName": f"Pessimistic ({currency})",
                        "field": "pessimistic",
                        "type": "rightAligned",
                        "valueFormatter": money_fmt,
                    },
                    {
                        "headerName": f"Expected ({currency})",
                        "field": "expected",
                        "type": "rightAligned",
                        "valueFormatter": money_fmt,
                    },
                    {
                        "headerName": f"Optimistic ({currency})",
                        "field": "optimistic",
                        "type": "rightAligned",
                        "valueFormatter": money_fmt,
                    },
                ],
                "rowData": rows,
                "defaultColDef": {"sortable": True, "resizable": True},
                "pagination": True,
                "paginationAutoPageSize": True,
            }
        ).classes("ag-theme-alpine w-full h-[50vh]")
