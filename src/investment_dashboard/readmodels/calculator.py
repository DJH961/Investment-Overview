"""Calculator read-model — forward projection scenarios (yearly + monthly).

Wraps the shared projection helpers in
:mod:`investment_dashboard.ui.pages._projection_query`.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.ui.pages._projection_query import (
    DEFAULT_SCENARIOS,
    MonthlyProjectionRow,
    ProjectionRow,
    project_from_session,
    project_monthly_from_session,
)


def _values_by_rate(values: dict[Any, Any]) -> dict[str, str | None]:
    # ``values_by_rate`` is keyed by the Decimal annual-rate scenario;
    # serialize the keys as strings so the mapping is JSON-safe.
    return {format(rate, "f"): dec(value) for rate, value in values.items()}


def _yearly_dict(r: ProjectionRow) -> dict[str, Any]:
    return {
        "year": r.year,
        "contributed_eur": dec(r.contributed),
        "values_by_rate_eur": _values_by_rate(r.values_by_rate),
    }


def _monthly_dict(r: MonthlyProjectionRow) -> dict[str, Any]:
    return {
        "label": r.label,
        "contributed_eur": dec(r.contributed),
        "values_by_rate_eur": _values_by_rate(r.values_by_rate),
    }


def build(
    session: Session,
    *,
    context: ReadModelContext | None = None,
    years: int = 10,
    months: int = 36,
) -> dict[str, Any]:
    """Return the JSON-serializable calculator read-model."""
    ctx = context or build_context(session)
    yearly = project_from_session(session, years=years, today=ctx.as_of)
    monthly = project_monthly_from_session(session, months=months, today=ctx.as_of)
    return {
        "scenarios": [format(r, "f") for r in DEFAULT_SCENARIOS],
        "yearly": [_yearly_dict(r) for r in yearly],
        "monthly": [_monthly_dict(r) for r in monthly],
    }
