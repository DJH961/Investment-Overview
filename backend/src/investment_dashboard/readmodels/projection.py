"""Projection seed, parameter mapping and the what-if response (UI-free).

Extracted from ``ui/pages/_projection_view.py`` so the v6 API and the NiceGUI page
share one implementation. The pure engine lives in
:mod:`investment_dashboard.readmodels.queries.projection_model`.

Currency: each wallet is simulated at its **own** historical XIRR (EUR at the EUR
XIRR, USD at the USD XIRR); a return is never converted. Starting values are
single-instant valuations. The only conversion is a *forward assumption*: the
contribution/target entered in the primary currency is carried to the other
wallet at today's spot (``usd_per_eur``), which the response flags under
``assumptions``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import market_hours
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.queries.period_query import PeriodRow, aggregate
from investment_dashboard.readmodels.queries.projection_model import (
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

ZERO = Decimal(0)
ONE = Decimal(1)


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


def _mean_positive(values: list[Decimal]) -> Decimal:
    positive = [v for v in values if v > 0]
    if not positive:
        return ZERO
    return sum(positive, start=ZERO) / Decimal(len(positive))


def _avg_contribution(rows: list[PeriodRow]) -> Decimal:
    """Mean of historical positive contributions (withdrawal-only periods ignored)."""
    return _mean_positive([r.contributions for r in rows])


def _avg_contribution_usd(session: Session, *, monthly: bool, today: date) -> Decimal | None:
    """Mean positive USD contribution from per-trade-date USD legs (``None`` if unavailable)."""
    rows = aggregate(
        session, monthly=monthly, with_closing_value=False, today=today, display_currency="USD"
    )
    usd = [r.contributions_display for r in rows if r.contributions_display is not None]
    if not rows or len(usd) != len(rows):
        return None
    return _mean_positive(usd)


def build_seed(
    session: Session,
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

    today = today or market_hours.exchange_today()
    metrics = metrics_service.compute_portfolio_metrics(session, as_of=today)

    rows = aggregate(session, monthly=monthly, with_closing_value=False, today=today)
    avg_eur = _avg_contribution(rows)

    # EUR→USD spot. Prefer the live FX rate; fall back to the ratio implied
    # by the dual-currency portfolio value; finally 1.0 so the page renders.
    rate = display_currency_service.current_rate(session, quote="USD")
    if (
        (rate is None or rate == 0)
        and metrics.total_value_usd is not None
        and metrics.total_value_eur > 0
    ):
        rate = metrics.total_value_usd / metrics.total_value_eur
    usd_per_eur = rate if rate and rate > 0 else ONE

    # USD average contribution from the USD legs (trade-date rates); only when
    # that is unavailable fall back to a spot conversion of the EUR average.
    avg_usd = _avg_contribution_usd(session, monthly=monthly, today=today)
    if avg_usd is None:
        avg_usd = avg_eur * usd_per_eur

    return ProjectionSeed(
        monthly=monthly,
        primary=primary.upper(),
        starting_eur=metrics.total_value_eur,
        starting_usd=(
            metrics.total_value_usd
            if metrics.total_value_usd is not None
            else metrics.total_value_eur * usd_per_eur
        ),
        avg_contribution_eur=avg_eur,
        avg_contribution_usd=avg_usd,
        expected_rate_eur=default_expected_rate(metrics.xirr),
        expected_rate_usd=default_expected_rate(metrics.xirr_usd),
        usd_per_eur=usd_per_eur,
        xirr_available=metrics.xirr is not None or metrics.xirr_usd is not None,
        today=today,
    )


def build_params(
    seed: ProjectionSeed,
    *,
    expected_primary: Decimal,
    band: Decimal,
    stepup: Decimal,
    inflation: Decimal,
    horizon: int,
    contrib_primary: Decimal,
) -> tuple[ProjectionParams, ProjectionParams]:
    """Build the ``(EUR, USD)`` simulation params from fractional control values.

    The user edits a single expected return (in the primary currency); the other
    currency's expected return is offset by the **historical spread** between the
    two XIRRs (an assumption, not a conversion). ``band``/``stepup``/``inflation``
    are fractions (``0.03`` = 3 %).
    """
    spread = seed.expected_rate_usd - seed.expected_rate_eur  # usd minus eur
    if seed.primary == "EUR":
        expected_eur = expected_primary
        expected_usd = expected_primary + spread
        contrib_eur = contrib_primary
        contrib_usd = contrib_primary * seed.usd_per_eur
    else:
        expected_usd = expected_primary
        expected_eur = expected_primary - spread
        contrib_usd = contrib_primary
        contrib_eur = contrib_primary / seed.usd_per_eur if seed.usd_per_eur else contrib_primary

    horizon = max(horizon, 0)
    params_eur = ProjectionParams(
        starting_value=seed.starting_eur,
        base_contribution=contrib_eur,
        periods=horizon,
        periods_per_year=seed.periods_per_year,
        annual_rates=band_rates(expected_eur, band),
        annual_contribution_growth=stepup,
        inflation_rate=inflation,
        start=seed.today,
    )
    params_usd = ProjectionParams(
        starting_value=seed.starting_usd,
        base_contribution=contrib_usd,
        periods=horizon,
        periods_per_year=seed.periods_per_year,
        annual_rates=band_rates(expected_usd, band),
        annual_contribution_growth=stepup,
        inflation_rate=inflation,
        start=seed.today,
    )
    return params_eur, params_usd


def seed_dict(seed: ProjectionSeed, ccy: str) -> dict[str, Any]:
    """The projection defaults in ``ccy`` (each wallet's own values; no return conversion)."""
    usd = ccy.upper() == "USD"
    return {
        "monthly": seed.monthly,
        "ccy": ccy.upper(),
        "starting_value": dec(seed.starting_usd if usd else seed.starting_eur),
        "avg_contribution": dec(seed.avg_contribution_usd if usd else seed.avg_contribution_eur),
        "expected_rate": dec(seed.expected_rate_usd if usd else seed.expected_rate_eur),
        "xirr_available": seed.xirr_available,
        "usd_per_eur": dec(seed.usd_per_eur),
        "as_of": seed.today.isoformat(),
    }


def _final(result: ProjectionResult, scenario: str, *, real: bool) -> Decimal:
    last = result.final
    if last is None:
        return result.params.starting_value
    return (last.real_by_scenario if real else last.nominal_by_scenario)[scenario]


def project(
    seed: ProjectionSeed,
    *,
    ccy: str,
    expected_rate: Decimal | None = None,
    band: Decimal = Decimal("0.03"),
    stepup: Decimal = ZERO,
    inflation: Decimal = Decimal("0.02"),
    horizon: int | None = None,
    contribution: Decimal | None = None,
    target: Decimal = ZERO,
    real: bool = False,
) -> dict[str, Any]:
    """Simulate the wallet in ``ccy`` and shape the what-if response.

    ``expected_rate``/``band``/``stepup``/``inflation`` are fractions. Defaults:
    the ``ccy`` wallet's own historical XIRR and average contribution.
    """
    ccy = ccy.upper()
    usd = ccy == "USD"
    seeded = ProjectionSeed(
        monthly=seed.monthly,
        primary=ccy,
        starting_eur=seed.starting_eur,
        starting_usd=seed.starting_usd,
        avg_contribution_eur=seed.avg_contribution_eur,
        avg_contribution_usd=seed.avg_contribution_usd,
        expected_rate_eur=seed.expected_rate_eur,
        expected_rate_usd=seed.expected_rate_usd,
        usd_per_eur=seed.usd_per_eur,
        xirr_available=seed.xirr_available,
        today=seed.today,
    )
    default_rate = seed.expected_rate_usd if usd else seed.expected_rate_eur
    expected = expected_rate if expected_rate is not None else default_rate
    contrib = (
        contribution
        if contribution is not None
        else (seed.avg_contribution_usd if usd else seed.avg_contribution_eur)
    )
    periods = horizon if horizon is not None else (120 if seed.monthly else 10)
    params_eur, params_usd = build_params(
        seeded,
        expected_primary=expected,
        band=band,
        stepup=stepup,
        inflation=inflation,
        horizon=periods,
        contrib_primary=contrib,
    )
    params = params_usd if usd else params_eur
    result = simulate(params)

    ppy = Decimal(seed.periods_per_year)
    points = [
        {
            "label": p.label,
            "years": dec(Decimal(p.index) / ppy),
            "contributed": dec(p.contributed),
            "pessimistic": dec(p.nominal_by_scenario[SCENARIO_PESSIMISTIC]),
            "expected": dec(p.nominal_by_scenario[SCENARIO_EXPECTED]),
            "optimistic": dec(p.nominal_by_scenario[SCENARIO_OPTIMISTIC]),
            "pessimistic_real": dec(p.real_by_scenario[SCENARIO_PESSIMISTIC]),
            "expected_real": dec(p.real_by_scenario[SCENARIO_EXPECTED]),
            "optimistic_real": dec(p.real_by_scenario[SCENARIO_OPTIMISTIC]),
        }
        for p in result.points
    ]
    hits: dict[str, dict[str, str | None] | None] = {}
    for scenario, hit in time_to_target(result, target, real=real).items():
        hits[scenario] = {"label": hit.label, "years": dec(hit.years)} if hit is not None else None
    needed = required_contribution(params, target) if target > 0 else None
    expected_final = _final(result, SCENARIO_EXPECTED, real=real)
    return {
        "ccy": ccy,
        "monthly": seed.monthly,
        "real": real,
        "as_of": seed.today.isoformat(),
        "starting_value": dec(params.starting_value),
        "total_contributed": dec(result.total_contributed),
        "final": {
            "pessimistic": dec(_final(result, SCENARIO_PESSIMISTIC, real=real)),
            "expected": dec(expected_final),
            "optimistic": dec(_final(result, SCENARIO_OPTIMISTIC, real=real)),
            "projected_growth": dec(
                expected_final - params.starting_value - result.total_contributed
            ),
        },
        "points": points,
        "hits": hits,
        "required_contribution": dec(needed),
        "inputs": {
            "expected_rate": dec(expected),
            "band": dec(band),
            "stepup": dec(stepup),
            "inflation": dec(inflation),
            "horizon": periods,
            "contribution": dec(contrib),
            "target": dec(target),
        },
        "assumptions": {
            "usd_per_eur": dec(seed.usd_per_eur),
            "expected_rate_default": dec(default_rate),
            "xirr_available": seed.xirr_available,
        },
    }
