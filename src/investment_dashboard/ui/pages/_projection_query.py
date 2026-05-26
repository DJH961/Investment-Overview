"""Hypothetical-projection helper used by ``/yearly`` and ``/monthly`` (v1.1+).

Forward-projects the portfolio's EUR value under a set of constant
annual-growth scenarios, assuming the average historical contribution
continues each year. Pure math + a thin DB read so it stays unit-testable
without NiceGUI.

v1.2 adds the monthly variant: ``project_monthly`` compounds at the
monthly-equivalent of each annual rate and accepts the average historical
monthly contribution.
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


@dataclass(frozen=True)
class MonthlyProjectionRow:
    """One month of the projection table (year-month label)."""

    label: str  # YYYY-MM
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


def _avg_monthly_contribution(monthly_rows: list[PeriodRow]) -> Decimal:
    """Mean of historical monthly contributions (positive months only)."""
    contribs = [r.contributions for r in monthly_rows if r.contributions > 0]
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


def _monthly_rate(annual_rate: Decimal) -> Decimal:
    """``(1 + r)^(1/12) - 1`` as a Decimal (via float; display precision is fine)."""
    base = Decimal(1) + annual_rate
    return Decimal(repr(float(base) ** (1.0 / 12.0))) - Decimal(1)


def project_monthly(
    starting_value_eur: Decimal,
    monthly_contribution_eur: Decimal,
    *,
    months: int,
    scenarios: tuple[Decimal, ...] = DEFAULT_SCENARIOS,
    start: date | None = None,
) -> list[MonthlyProjectionRow]:
    """Forward-project ``months`` months from ``starting_value_eur``.

    ``scenarios`` are **annual** rates; we compound at their monthly
    equivalent. Contributions are added at month-end. Labels are the
    ``YYYY-MM`` of the **next** month after ``start`` (or today).
    """
    if months < 0:
        raise ValueError("months must be non-negative")
    for r in scenarios:
        if r <= Decimal("-1"):
            raise ValueError(f"scenario rate {r} would zero out the portfolio")

    start = start or date.today()
    monthly_rates = {r: _monthly_rate(r) for r in scenarios}
    values = {r: starting_value_eur for r in scenarios}
    cumulative_contrib = ZERO
    out: list[MonthlyProjectionRow] = []
    year, month = start.year, start.month
    for _ in range(months):
        month += 1
        if month == 13:
            month = 1
            year += 1
        cumulative_contrib += monthly_contribution_eur
        for r in scenarios:
            values[r] = values[r] * (Decimal(1) + monthly_rates[r]) + monthly_contribution_eur
        out.append(
            MonthlyProjectionRow(
                label=f"{year:04d}-{month:02d}",
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


def project_monthly_from_session(
    session: Session,
    *,
    months: int = 36,
    scenarios: tuple[Decimal, ...] = DEFAULT_SCENARIOS,
    today: date | None = None,
) -> list[MonthlyProjectionRow]:
    """Pull current portfolio + average historical monthly contribution, then project."""
    from investment_dashboard.services import positions_service  # noqa: PLC0415

    today = today or date.today()
    starting = positions_service.total_portfolio_value(session, as_of=today)
    monthly_rows = aggregate(session, monthly=True, with_closing_value=False, today=today)
    return project_monthly(
        starting,
        _avg_monthly_contribution(monthly_rows),
        months=months,
        scenarios=scenarios,
        start=today,
    )


def to_table_rows(
    rows: list[ProjectionRow],
    *,
    currency: str = "EUR",
    fx_rate: Decimal | None = None,
) -> list[dict[str, str]]:
    """Format yearly-projection rows, converting EUR→``currency`` for display."""

    currency = currency.upper()

    def conv(value: Decimal) -> Decimal:
        if currency == "EUR" or fx_rate is None or fx_rate == 0:
            return value
        return value * fx_rate

    def usd(value: Decimal) -> Decimal:
        if fx_rate is None or fx_rate == 0:
            return value
        return value * fx_rate

    out: list[dict[str, str]] = []
    for r in rows:
        row: dict[str, str] = {
            "year": str(r.year),
            "contributed": f"{conv(r.contributed):,.2f}",
            "contributed_eur": f"{r.contributed:,.2f}",
            "contributed_usd": f"{usd(r.contributed):,.2f}",
        }
        for rate, value in r.values_by_rate.items():
            row[f"rate_{rate}"] = f"{conv(value):,.2f}"
            row[f"rate_{rate}_eur"] = f"{value:,.2f}"
            row[f"rate_{rate}_usd"] = f"{usd(value):,.2f}"
        out.append(row)
    return out


def to_monthly_table_rows(
    rows: list[MonthlyProjectionRow],
    *,
    currency: str = "EUR",
    fx_rate: Decimal | None = None,
) -> list[dict[str, str]]:
    """Format monthly-projection rows, converting EUR→``currency`` for display."""

    currency = currency.upper()

    def conv(value: Decimal) -> Decimal:
        if currency == "EUR" or fx_rate is None or fx_rate == 0:
            return value
        return value * fx_rate

    def usd(value: Decimal) -> Decimal:
        if fx_rate is None or fx_rate == 0:
            return value
        return value * fx_rate

    out: list[dict[str, str]] = []
    for r in rows:
        row: dict[str, str] = {
            "label": r.label,
            "contributed": f"{conv(r.contributed):,.2f}",
            "contributed_eur": f"{r.contributed:,.2f}",
            "contributed_usd": f"{usd(r.contributed):,.2f}",
        }
        for rate, value in r.values_by_rate.items():
            row[f"rate_{rate}"] = f"{conv(value):,.2f}"
            row[f"rate_{rate}_eur"] = f"{value:,.2f}"
            row[f"rate_{rate}_usd"] = f"{usd(value):,.2f}"
        out.append(row)
    return out
