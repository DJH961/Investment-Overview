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

* :func:`build_seed` — a thin DB read capturing both starting values, the
  average historical contribution, and **both** per-currency XIRRs.
* :func:`render` — the live NiceGUI widget: assumption controls, a Plotly
  outcome cone (primary currency), dual-currency KPI tiles, an implied-FX
  readout, a goal-seeking callout, and a dual-currency per-period table.

All heavy math lives in :mod:`._projection_model`; this layer captures
inputs, runs the two simulations, and draws.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from nicegui import ui

from investment_dashboard.ui.components import section
from investment_dashboard.ui.components.kpi_card import dual_kpi_card
from investment_dashboard.ui.money_format import dual_money, fmt_money
from investment_dashboard.ui.pages._period_query import aggregate
from investment_dashboard.ui.pages._projection_model import (
    SCENARIO_EXPECTED,
    SCENARIO_OPTIMISTIC,
    SCENARIO_PESSIMISTIC,
    ProjectionParams,
    ProjectionResult,
    band_rates,
    default_expected_rate,
    required_contribution,
    simulate,
    time_to_target,
)
from investment_dashboard.ui.theme import GAIN_COLOR

ZERO = Decimal(0)
ONE = Decimal(1)

_SCENARIO_LABEL = {
    SCENARIO_PESSIMISTIC: "Pessimistic",
    SCENARIO_EXPECTED: "Expected",
    SCENARIO_OPTIMISTIC: "Optimistic",
}


@dataclass(frozen=True)
class ProjectionSeed:
    """Starting point + per-currency defaults for the projection controls."""

    monthly: bool
    primary: str  # "EUR" or "USD" — display-currency ordering only
    starting_eur: Decimal
    starting_usd: Decimal
    avg_contribution_eur: Decimal
    avg_contribution_usd: Decimal
    expected_rate_eur: Decimal  # annual, sanitised
    expected_rate_usd: Decimal  # annual, sanitised
    usd_per_eur: Decimal  # current EUR→USD spot, for contribution/target conversion
    xirr_available: bool
    today: date

    @property
    def periods_per_year(self) -> int:
        return 12 if self.monthly else 1


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
    primary: str,
    today: date | None = None,
) -> ProjectionSeed:
    """Read live portfolio state and derive both-currency projection inputs."""
    from investment_dashboard.services import (  # noqa: PLC0415
        display_currency_service,
        metrics_service,
    )

    today = today or date.today()
    metrics = metrics_service.compute_portfolio_metrics(session, as_of=today)

    rows = aggregate(session, monthly=monthly, with_closing_value=False, today=today)
    avg_eur = _avg_contribution(rows)

    # EUR→USD spot. Prefer the live FX rate; fall back to the ratio implied
    # by the dual-currency portfolio value; finally 1.0 so the page renders.
    rate = display_currency_service.current_rate(session, quote="USD")
    if (rate is None or rate == 0) and metrics.total_value_eur > 0:
        rate = metrics.total_value_usd / metrics.total_value_eur
    usd_per_eur = rate if rate and rate > 0 else ONE

    return ProjectionSeed(
        monthly=monthly,
        primary=primary.upper(),
        starting_eur=metrics.total_value_eur,
        starting_usd=metrics.total_value_usd,
        avg_contribution_eur=avg_eur,
        avg_contribution_usd=avg_eur * usd_per_eur,
        expected_rate_eur=default_expected_rate(metrics.xirr),
        expected_rate_usd=default_expected_rate(metrics.xirr_usd),
        usd_per_eur=usd_per_eur,
        xirr_available=metrics.xirr is not None or metrics.xirr_usd is not None,
        today=today,
    )


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
            f"(expected ≈ {primary_expected * 100:.1f}% p.a. in {primary}). "
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
        _render_implied_fx(seed, result_eur, result_usd, real=real)
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

    The user edits a single expected return (in the primary currency); the
    secondary currency's expected return is offset by the **historical
    spread** between the two XIRRs, preserving the realistic, FX-driven gap
    as the user explores scenarios.
    """
    primary = seed.primary
    expected_primary = _num(controls["expected"].value) / Decimal(100)
    spread = seed.expected_rate_usd - seed.expected_rate_eur  # usd minus eur
    if primary == "EUR":
        expected_eur = expected_primary
        expected_usd = expected_primary + spread
    else:
        expected_usd = expected_primary
        expected_eur = expected_primary - spread

    band = _num(controls["band"].value) / Decimal(100)
    stepup = _num(controls["stepup"].value) / Decimal(100)
    inflation = _num(controls["inflation"].value) / Decimal(100)
    horizon = max(int(_num(controls["horizon"].value)), 0)
    real = bool(controls["real"].value)

    contrib_primary = _num(controls["contribution"].value)
    if primary == "EUR":
        contrib_eur = contrib_primary
        contrib_usd = contrib_primary * seed.usd_per_eur
    else:
        contrib_usd = contrib_primary
        contrib_eur = contrib_primary / seed.usd_per_eur if seed.usd_per_eur else contrib_primary

    target_primary = _num(controls["target"].value)

    common = {
        "periods": horizon,
        "periods_per_year": seed.periods_per_year,
        "annual_contribution_growth": stepup,
        "inflation_rate": inflation,
        "start": seed.today,
    }
    params_eur = ProjectionParams(
        starting_value=seed.starting_eur,
        base_contribution=contrib_eur,
        annual_rates=band_rates(expected_eur, band),
        **common,  # type: ignore[arg-type]
    )
    params_usd = ProjectionParams(
        starting_value=seed.starting_usd,
        base_contribution=contrib_usd,
        annual_rates=band_rates(expected_usd, band),
        **common,  # type: ignore[arg-type]
    )
    return params_eur, params_usd, target_primary, real


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
    money_kind = "real" if real else "nominal"
    with ui.row().classes("gap-md flex-wrap q-mt-sm"):
        dual_kpi_card(
            "Expected value",
            fmt_money(_final(result_eur, SCENARIO_EXPECTED, real=real), "EUR"),
            fmt_money(_final(result_usd, SCENARIO_EXPECTED, real=real), "USD"),
            primary=primary,
            tooltip_key="projection_expected",
        )
        dual_kpi_card(
            "Optimistic",
            fmt_money(_final(result_eur, SCENARIO_OPTIMISTIC, real=real), "EUR"),
            fmt_money(_final(result_usd, SCENARIO_OPTIMISTIC, real=real), "USD"),
            primary=primary,
        )
        dual_kpi_card(
            "Pessimistic",
            fmt_money(_final(result_eur, SCENARIO_PESSIMISTIC, real=real), "EUR"),
            fmt_money(_final(result_usd, SCENARIO_PESSIMISTIC, real=real), "USD"),
            primary=primary,
        )
        dual_kpi_card(
            "Additionally contributed",
            fmt_money(result_eur.total_contributed, "EUR"),
            fmt_money(result_usd.total_contributed, "USD"),
            primary=primary,
        )
        gain_eur = (
            _final(result_eur, SCENARIO_EXPECTED, real=real)
            - result_eur.params.starting_value
            - result_eur.total_contributed
        )
        gain_usd = (
            _final(result_usd, SCENARIO_EXPECTED, real=real)
            - result_usd.params.starting_value
            - result_usd.total_contributed
        )
        dual_kpi_card(
            f"Projected growth ({money_kind})",
            fmt_money(gain_eur, "EUR"),
            fmt_money(gain_usd, "USD"),
            primary=primary,
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


def _render_implied_fx(
    seed: ProjectionSeed,
    result_eur: ProjectionResult,
    result_usd: ProjectionResult,
    *,
    real: bool,
) -> None:
    """Surface the EUR/USD rate the two return streams imply at the horizon."""
    final_eur = _final(result_eur, SCENARIO_EXPECTED, real=real)
    final_usd = _final(result_usd, SCENARIO_EXPECTED, real=real)
    if final_eur <= 0:
        return
    implied = final_usd / final_eur
    today_rate = seed.usd_per_eur
    drift = ((implied / today_rate) - ONE) * Decimal(100) if today_rate else ZERO
    arrow = "↑" if implied >= today_rate else "↓"
    ui.label(
        f"Implied EUR/USD at horizon: {implied:.4f} {arrow}  "
        f"(today {today_rate:.4f}, {drift:+.1f}% — the gap between the EUR and USD "
        "return assumptions, not a fixed-rate conversion)."
    ).classes("text-caption opacity-70")


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
    rows = []
    for pe, pu in zip(result_eur.points, result_usd.points, strict=True):

        def cell(scenario: str) -> str:
            return dual_money(
                _series(pe, scenario, real=real),  # noqa: B023 - bound per iteration
                _series(pu, scenario, real=real),  # noqa: B023
                primary=primary,
                decimals=2,
            )

        rows.append(
            {
                "label": pe.label,
                "contributed": dual_money(
                    pe.contributed, pu.contributed, primary=primary, decimals=2
                ),
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
