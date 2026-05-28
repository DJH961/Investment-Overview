"""Monthly / yearly period read-models — cashflow buckets + growth.

Both wrap the shared :func:`investment_dashboard.ui.pages._period_query.aggregate`
so the figures match the NiceGUI monthly/yearly tables exactly.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.ui.pages._period_query import PeriodRow, aggregate


def _row_dict(r: PeriodRow) -> dict[str, Any]:
    return {
        "label": r.label,
        "contributions_eur": dec(r.contributions),
        "dividends_eur": dec(r.dividends),
        "interest_eur": dec(r.interest),
        "net_flow_eur": dec(r.net_flow),
        "opening_value_eur": dec(r.opening_value_eur),
        "closing_value_eur": dec(r.closing_value_eur),
        "growth_pct": dec(r.growth_pct),
        # Per-trade-date FX-converted figures, populated only when the
        # display currency is non-EUR and FX history is available.
        "display_currency": r.display_currency or None,
        "contributions_display": dec(r.contributions_display),
        "dividends_display": dec(r.dividends_display),
        "interest_display": dec(r.interest_display),
        "net_flow_display": dec(r.net_flow_display),
        "opening_value_display": dec(r.opening_value_display),
        "closing_value_display": dec(r.closing_value_display),
        "growth_pct_display": dec(r.growth_pct_display),
    }


def _build(
    session: Session,
    *,
    monthly: bool,
    context: ReadModelContext | None,
) -> dict[str, Any]:
    ctx = context or build_context(session)
    rows = aggregate(
        session,
        monthly=monthly,
        today=ctx.as_of,
        display_currency=ctx.display_currency,
    )
    return {"rows": [_row_dict(r) for r in rows]}


def build_monthly(session: Session, *, context: ReadModelContext | None = None) -> dict[str, Any]:
    """Return the JSON-serializable monthly read-model."""
    return _build(session, monthly=True, context=context)


def build_yearly(session: Session, *, context: ReadModelContext | None = None) -> dict[str, Any]:
    """Return the JSON-serializable yearly read-model."""
    return _build(session, monthly=False, context=context)
