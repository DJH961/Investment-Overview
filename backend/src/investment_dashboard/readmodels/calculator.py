"""Calculator read-model — forward projection scenarios (yearly + monthly).

Wraps the shared projection helpers in
:mod:`investment_dashboard.readmodels.queries.projection_query`.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.queries.projection_query import (
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


def build_inputs(
    session: Session,
    *,
    ccy: str,
    context: ReadModelContext | None = None,
) -> dict[str, Any]:
    """Calculator inputs/defaults: projection seeds (both granularities) + holdings mix.

    Holdings values are EUR marks restated into ``ccy`` at today's spot (a
    single-instant valuation conversion); ``fx_usd_per_eur`` is echoed so the
    client can show the rate used. ``None`` when no rate exists.
    """
    from investment_dashboard.readmodels.projection import build_seed, seed_dict  # noqa: PLC0415
    from investment_dashboard.readmodels.queries.calculator_query import (  # noqa: PLC0415
        build_calculator_data,
    )

    ccy = ccy.upper()
    ctx = context or build_context(session)
    data = build_calculator_data(session)
    factor: Decimal | None = Decimal(1)
    if ccy == "USD":
        factor = data.fx_rate_usd_per_eur if data.fx_rate_usd_per_eur else None

    def _val(eur: Decimal) -> str | None:
        return dec(eur * factor) if factor is not None else None

    return {
        "ccy": ccy,
        "as_of": ctx.as_of.isoformat(),
        "fx_usd_per_eur": dec(data.fx_rate_usd_per_eur),
        "total_value": _val(data.total_value_eur),
        "instruments": [
            {
                "instrument_id": i.instrument_id,
                "symbol": i.symbol,
                "name": i.name,
                "category": i.category,
                "current_value": _val(i.current_value_eur),
                "current_pct": dec(i.current_pct),
            }
            for i in data.instruments
        ],
        "categories": [
            {
                "name": c.name,
                "current_value": _val(c.current_value_eur),
                "current_pct": dec(c.current_pct),
                "members": [m.instrument_id for m in c.members],
            }
            for c in data.categories
        ],
        "projection_defaults": {
            "month": seed_dict(
                build_seed(session, monthly=True, primary=ccy, today=ctx.as_of), ccy
            ),
            "year": seed_dict(
                build_seed(session, monthly=False, primary=ccy, today=ctx.as_of), ccy
            ),
        },
    }
