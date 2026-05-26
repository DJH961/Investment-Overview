"""Hypothetical-projection helper used by ``/yearly`` (v1.1).

Forward-projects the portfolio's EUR value under a set of constant
annual-growth scenarios, assuming the average historical contribution
continues each year. Pure math + a thin DB read so it stays unit-testable
without NiceGUI.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.ui.pages._period_query import PeriodRow, aggregate

ZERO = Decimal(0)

# Conservative / moderate / optimistic real-return assumptions.
DEFAULT_SCENARIOS: tuple[Decimal, ...] = (
    Decimal("0.04"),
    Decimal("0.07"),
    Decimal("0.10"),
)


@dataclass(frozen=True)
class ProjectionRow:
    """One year of the projection table."""

    year: int
    contributed: Decimal
    values_by_rate: dict[Decimal, Decimal]


def _avg_yearly_contribution(yearly_rows: list[PeriodRow]) -> Decimal:
    """Mean of historical yearly contributions (deposit − withdrawal).

    Negative individual years are treated as ``0`` for the purpose of
    estimating a forward-looking savings cadence — withdrawals are not
    a meaningful predictor of future contributions.
    """
    contribs = [r.contributions for r in yearly_rows if r.contributions > 0]
    if not contribs:
        return ZERO
    return sum(contribs, start=ZERO) / Decimal(len(contribs))


def project(
    starting_value_eur: Decimal,
    annual_contribution_eur: Decimal,
    *,
    years: int,
    scenarios: tuple[Decimal, ...] = DEFAULT_SCENARIOS,
    start_year: int | None = None,
) -> list[ProjectionRow]:
    """Forward-project ``years`` years from ``starting_value_eur``.

    Each year the portfolio grows by the scenario rate **then** receives
    the annual contribution at year-end (an ordinary annuity). The
    ``contributed`` column is the cumulative new money — useful for
    comparing scenarios against pure contribution.

    Raises ``ValueError`` if ``years`` is negative or any rate ≤ -1.
    """
    if years < 0:
        raise ValueError("years must be non-negative")
    for r in scenarios:
        if r <= Decimal("-1"):
            raise ValueError(f"scenario rate {r} would zero out the portfolio")

    base_year = start_year if start_year is not None else date.today().year
    values = {r: starting_value_eur for r in scenarios}
    cumulative_contrib = ZERO
    out: list[ProjectionRow] = []
    for offset in range(1, years + 1):
        cumulative_contrib += annual_contribution_eur
        for r in scenarios:
            values[r] = values[r] * (Decimal(1) + r) + annual_contribution_eur
        out.append(
            ProjectionRow(
                year=base_year + offset,
                contributed=cumulative_contrib,
                values_by_rate=dict(values),
            )
        )
    return out


def project_from_session(
    session: Session,
    *,
    years: int = 10,
    scenarios: tuple[Decimal, ...] = DEFAULT_SCENARIOS,
    today: date | None = None,
) -> list[ProjectionRow]:
    """Pull live portfolio state and contribution history, then project."""
    from investment_dashboard.services import positions_service  # noqa: PLC0415

    today = today or date.today()
    starting = positions_service.total_portfolio_value(session, as_of=today)
    yearly = aggregate(session, monthly=False, with_closing_value=False, today=today)
    return project(
        starting,
        _avg_yearly_contribution(yearly),
        years=years,
        scenarios=scenarios,
        start_year=today.year,
    )


def to_table_rows(rows: list[ProjectionRow]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for r in rows:
        row: dict[str, str] = {
            "year": str(r.year),
            "contributed": f"{r.contributed:,.2f}",
        }
        for rate, value in r.values_by_rate.items():
            row[f"rate_{rate}"] = f"{value:,.2f}"
        out.append(row)
    return out
