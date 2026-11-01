"""Interactive projection tool — shared UI for ``/monthly`` and ``/yearly``.

This module owns the *Projection* section both period pages render. It is
**dual-currency by construction** (v2.5 convention): the portfolio is
projected forward *twice* — once as a EUR wallet and once as a USD wallet
— each compounding at its **own** historical XIRR. Because the two return
streams diverge exactly as they have historically, the EUR/USD figures are
never a naïve fixed-rate conversion of one another; the implied future
EUR/USD rate drifts on its own, and we surface it explicitly. That is the
"account for both currencies *and* changing exchange rates" requirement,
done the same way v2.5 walks the ledger twice rather than dividing by one
spot rate.

Responsibilities:

* :func:`build_seed` (in :mod:`readmodels.projection`) — a thin DB read capturing both starting values, the
  average historical contribution, and **both** per-currency XIRRs.
* :func:`render` — the live NiceGUI widget: assumption controls, a Plotly
  outcome cone, single-currency KPI tiles (the user's chosen display
  currency), a goal-seeking callout, and a per-period table. Both currencies
  are still *simulated* (each at its own historical XIRR) so switching the
  display currency in Settings is instant, but only the selected one is shown.

All heavy math lives in :mod:`._projection_model`; this layer captures
inputs, runs the two simulations, and draws.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from nicegui import ui

from investment_dashboard.readmodels.projection import (
    ProjectionSeed,
    build_params,
    build_seed,
)
from investment_dashboard.ui.components import section
from investment_dashboard.ui.components.kpi_card import kpi_card
from investment_dashboard.ui.money_format import fmt_money, fmt_pct
from investment_dashboard.ui.pages._projection_model import (
    SCENARIO_EXPECTED,
    SCENARIO_OPTIMISTIC,
    SCENARIO_PESSIMISTIC,
    ProjectionParams,
    ProjectionResult,
    required_contribution,
    simulate,
    time_to_target,
)
from investment_dashboard.ui.theme import GAIN_COLOR

__all__ = ["ProjectionSeed", "build_seed", "render"]

ZERO = Decimal(0)
ONE = Decimal(1)

_SCENARIO_LABEL = {
    SCENARIO_PESSIMISTIC: "Pessimistic",
    SCENARIO_EXPECTED: "Expected",
    SCENARIO_OPTIMISTIC: "Optimistic",
}


def _num(value) -> Decimal:  # type: ignore[no-untyped-def]
    """Coerce a NiceGUI number-input value to ``Decimal`` (``0`` on junk)."""
    if value is None:
        return ZERO
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return ZERO


def _primary_first(seed: ProjectionSeed, eur: Decimal, usd: Decimal) -> tuple[Decimal, Decimal]:
    """Return ``(primary, secondary)`` in the seed's display order."""
    return (eur, usd) if seed.primary == "EUR" else (usd, eur)


def render(seed: ProjectionSeed) -> None:  # pragma: no cover - UI wiring
    """Render the full interactive, dual-currency projection tool."""
    period_word = "month" if seed.monthly else "year"
    primary = seed.primary
    primary_expected, _ = _primary_first(seed, seed.expected_rate_eur, seed.expected_rate_usd)
    primary_contrib, _ = _primary_first(seed, seed.avg_contribution_eur, seed.avg_contribution_usd)

    intro = (
        "Starts from your current portfolio value and projects it forward as **both** "
        "a EUR and a USD wallet — each growing at its own historical XIRR, so the two "
        "diverge exactly as currency moves have made them diverge before "
        + (
            f"(expected ≈ {fmt_pct(primary_expected)} p.a. in {primary}). "
            if seed.xirr_available
            else "(default assumption — not enough history for XIRR yet). "
        )
        + "Optimistic / pessimistic fan out by the band you choose. Planning aid, not a forecast."
    )
    ui.markdown(intro).classes("text-caption opacity-70")

    controls: dict[str, ui.element] = {}
    with ui.row().classes("gap-md items-end flex-wrap q-mb-sm"):
        controls["expected"] = (
            ui.number(
                f"Expected return % p.a. ({primary})",
                value=round(float(primary_expected * 100), 2),
                step=0.5,
                format="%.2f",
            )
            .props("dense outlined")
            .classes("w-48")
        )
        controls["band"] = (
            ui.number("± band (pp)", value=3.0, min=0, step=0.5, format="%.1f")
            .props("dense outlined")
            .classes("w-32")
        )
        controls["contribution"] = (
            ui.number(
                f"Contribution / {period_word} ({primary})",
                value=round(float(primary_contrib), 2),
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
            ui.number(f"Target value ({primary})", value=0.0, min=0, step=10000, format="%.0f")
            .props("dense outlined")
            .classes("w-44")
        )

    with ui.row().classes("gap-md items-center flex-wrap q-mb-sm"):
        ui.label(f"Horizon ({period_word}s):").classes("text-caption opacity-70")
        controls["horizon"] = (
            ui.slider(
                min=1,
                max=480 if seed.monthly else 40,
                value=120 if seed.monthly else 10,
                step=1,
            )
            .props("label-always")
            .classes("w-64")
        )
        controls["real"] = ui.switch("Show in today's money (real)", value=False)

    @ui.refreshable
    def body() -> None:
        params_eur, params_usd, target_primary, real = _params(seed, controls)
        result_eur = simulate(params_eur)
        result_usd = simulate(params_usd)
        primary_result = result_eur if primary == "EUR" else result_usd

        _render_kpis(seed, result_eur, result_usd, real=real)
        _render_chart(seed, primary_result, real=real, period_word=period_word)
        _render_goal(
            params_primary=(params_eur if primary == "EUR" else params_usd),
            primary_result=primary_result,
            target=target_primary,
            real=real,
            primary=primary,
            period_word=period_word,
        )
        _render_table(seed, result_eur, result_usd, real=real, period_word=period_word)

    def _refresh(_event: object = None) -> None:
        body.refresh()

    for element in controls.values():
        element.on_value_change(_refresh)

    body()


def _params(
    seed: ProjectionSeed,
    controls: dict[str, ui.element],
) -> tuple[ProjectionParams, ProjectionParams, Decimal, bool]:
    """Build the EUR + USD simulation params from live control values.

    Delegates to :func:`readmodels.projection.build_params` (shared with the API).
    """
    params_eur, params_usd = build_params(
        seed,
        expected_primary=_num(controls["expected"].value) / Decimal(100),
        band=_num(controls["band"].value) / Decimal(100),
        stepup=_num(controls["stepup"].value) / Decimal(100),
        inflation=_num(controls["inflation"].value) / Decimal(100),
        horizon=int(_num(controls["horizon"].value)),
        contrib_primary=_num(controls["contribution"].value),
    )
    return params_eur, params_usd, _num(controls["target"].value), bool(controls["real"].value)


def _series(point, scenario: str, *, real: bool) -> Decimal:  # type: ignore[no-untyped-def]
    return (point.real_by_scenario if real else point.nominal_by_scenario)[scenario]


def _final(result: ProjectionResult, scenario: str, *, real: bool) -> Decimal:
    last = result.final
    if last is None:
        return result.params.starting_value
    return _series(last, scenario, real=real)


def _render_kpis(
    seed: ProjectionSeed,
    result_eur: ProjectionResult,
    result_usd: ProjectionResult,
    *,
    real: bool,
) -> None:
    primary = seed.primary
    # Projection renders a single wallet in the user's chosen display currency
    # (the other currency's simulation still runs, but we only surface the one
    # the user picked — see module docstring / settings display-currency).
    result = result_eur if primary == "EUR" else result_usd
    money_kind = "real" if real else "nominal"
    with ui.row().classes("gap-md flex-wrap q-mt-sm"):
        kpi_card(
            "Expected value",
            fmt_money(_final(result, SCENARIO_EXPECTED, real=real), primary),
            tooltip_key="projection_expected",
        )
        kpi_card(
            "Optimistic",
            fmt_money(_final(result, SCENARIO_OPTIMISTIC, real=real), primary),
        )
        kpi_card(
            "Pessimistic",
            fmt_money(_final(result, SCENARIO_PESSIMISTIC, real=real), primary),
        )
        kpi_card(
            "Additionally contributed",
            fmt_money(result.total_contributed, primary),
        )
        gain = (
            _final(result, SCENARIO_EXPECTED, real=real)
            - result.params.starting_value
            - result.total_contributed
        )
        kpi_card(
            f"Projected growth ({money_kind})",
            fmt_money(gain, primary),
        )


def _render_chart(
    seed: ProjectionSeed,
    result: ProjectionResult,
    *,
    real: bool,
    period_word: str,
) -> None:
    import plotly.graph_objects as go  # noqa: PLC0415

    primary = seed.primary
    fig = go.Figure()
    if result.points:
        x = [p.label for p in result.points]

        def vals(scenario: str) -> list[float]:
            return [float(_series(p, scenario, real=real)) for p in result.points]

        pess, exp, opt = (
            vals(SCENARIO_PESSIMISTIC),
            vals(SCENARIO_EXPECTED),
            vals(SCENARIO_OPTIMISTIC),
        )
        invested = [float(p.contributed + result.params.starting_value) for p in result.points]

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
                y=invested,
                mode="lines",
                name="Invested (start + contributions)",
                line={"width": 1.4, "dash": "dash", "color": GAIN_COLOR},
            )
        )
    title_kind = "today's money" if real else "nominal"
    fig.update_layout(
        title=(
            f"Projected value over the next {len(result.points)} {period_word}s "
            f"({primary}, {title_kind})"
        ),
        template="colorblind_modern",
        margin={"l": 60, "r": 20, "t": 40, "b": 50},
        legend={"orientation": "h", "yanchor": "bottom", "y": 1.02},
        xaxis={"title": period_word.capitalize()},
        yaxis={"title": f"Value ({primary})"},
    )
    ui.plotly(fig).classes("w-full").style("height:420px")


def _fmt_years(years: Decimal) -> str:
    y = float(years)
    return f"{y:.1f} yr" if y >= 1 else f"{y * 12:.0f} mo"


def _render_goal(
    *,
    params_primary: ProjectionParams,
    primary_result: ProjectionResult,
    target: Decimal,
    real: bool,
    primary: str,
    period_word: str,
) -> None:
    if target <= 0:
        return
    target_disp = fmt_money(target, primary)
    hits = time_to_target(primary_result, target, real=real)
    with ui.card().classes("w-full q-mt-sm").style("background: rgba(46,134,193,0.06)"):
        ui.label(f"🎯 Reaching {target_disp} ({primary})").classes("text-subtitle2")
        with ui.row().classes("gap-lg flex-wrap"):
            for scenario in (SCENARIO_PESSIMISTIC, SCENARIO_EXPECTED, SCENARIO_OPTIMISTIC):
                hit = hits.get(scenario)
                when = f"{hit.label} ({_fmt_years(hit.years)})" if hit else "not within horizon"
                ui.label(f"{_SCENARIO_LABEL[scenario]}: {when}").classes("text-body2")
        needed = required_contribution(params_primary, target)
        if needed is not None:
            ui.label(
                "To reach it by the end of the horizon at the expected return, contribute about "
                f"{fmt_money(needed, primary)} per {period_word}."
            ).classes("text-caption opacity-80")
        else:
            ui.label(
                "Even large contributions can't reach this target within the horizon — "
                "extend the horizon or raise the expected return."
            ).classes("text-caption opacity-80")


def _render_table(
    seed: ProjectionSeed,
    result_eur: ProjectionResult,
    result_usd: ProjectionResult,
    *,
    real: bool,
    period_word: str,
) -> None:
    primary = seed.primary
    result = result_eur if primary == "EUR" else result_usd
    rows = []
    for point in result.points:

        def cell(scenario: str) -> str:
            return fmt_money(
                _series(point, scenario, real=real),  # noqa: B023 - bound per iteration
                primary,
                decimals=2,
            )

        rows.append(
            {
                "label": point.label,
                "contributed": fmt_money(point.contributed, primary, decimals=2),
                "pessimistic": cell(SCENARIO_PESSIMISTIC),
                "expected": cell(SCENARIO_EXPECTED),
                "optimistic": cell(SCENARIO_OPTIMISTIC),
            }
        )
    with section(f"Year-by-{period_word} detail"):
        ui.aggrid(
            {
                "columnDefs": [
                    {"headerName": period_word.capitalize(), "field": "label", "pinned": "left"},
                    {"headerName": "Contributed", "field": "contributed", "type": "rightAligned"},
                    {"headerName": "Pessimistic", "field": "pessimistic", "type": "rightAligned"},
                    {"headerName": "Expected", "field": "expected", "type": "rightAligned"},
                    {"headerName": "Optimistic", "field": "optimistic", "type": "rightAligned"},
                ],
                "rowData": rows,
                "defaultColDef": {"sortable": True, "resizable": True},
                "pagination": True,
                "paginationAutoPageSize": True,
            }
        ).classes("ag-theme-alpine w-full h-[50vh]")
