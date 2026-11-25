"""Monthly / yearly period read-models — cashflow buckets + growth.

Both wrap the shared :func:`investment_dashboard.readmodels.queries.period_query.aggregate`
so the figures match the NiceGUI monthly/yearly tables exactly.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain.real_return import label_months, period_real_return
from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.queries.period_query import PeriodRow, aggregate
from investment_dashboard.services import hicp_service

log = logging.getLogger(__name__)


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


def _hicp_index(session: Session) -> dict[str, Decimal]:
    """The stored HICP index; empty (no real return) when it cannot be read."""
    try:
        return hicp_service.get_index(session)
    except Exception:
        log.warning("HICP index unreadable; Periods show no real return", exc_info=True)
        return {}


def real_fields(growth: Decimal | None, label: str, index: Mapping[str, Decimal]) -> dict[str, Any]:
    """``real_return`` / ``real_to`` of one EUR period (7.4 P10).

    The nominal EUR growth over the period divided by the euro-area HICP change
    over the same months (``domain.real_return``). ``real_to`` is the last index
    month used (``YYYY-MM``): the index is published late. Both are ``None`` for a
    running month or without an index.
    """
    first, last = label_months(label)
    real = period_real_return(growth, index, first_month=first, last_month=last)
    if real is None:
        return {"real_return": None, "real_to": None}
    return {"real_return": dec(real.value), "real_to": real.to_month}


def _flat_row(
    r: PeriodRow,
    *,
    ccy: str,
    current_label: str,
    index: Mapping[str, Decimal] | None = None,
) -> dict[str, Any]:
    """One period flattened into the requested reporting currency.

    EUR reads the base fields; USD reads the per-trade-date ``*_display`` /
    ``*_usd`` fields built from the USD legs. A figure that does not exist in
    ``ccy`` (no FX history) is ``None`` -- never a scaled EUR number.
    """
    if ccy == "USD":
        closing = r.closing_value_display if r.display_currency == "USD" else None
        if closing is None:
            closing = r.closing_value_usd
        return {
            "label": r.label,
            "is_current": r.label == current_label,
            "contributions": dec(r.contributions_display),
            "dividends": dec(r.dividends_display),
            "interest": dec(r.interest_display),
            "net_flow": dec(r.net_flow_display),
            "opening_value": dec(r.opening_value_display),
            "closing_value": dec(closing),
            "growth_pct": dec(r.growth_pct_display),
            "total_growth_compounded": dec(r.total_growth_compounded_usd),
            "period_growth_xirr": dec(r.yearly_growth_usd),
            # Real return is a euro figure (euro-area prices): none in dollars.
            "real_return": None,
            "real_to": None,
        }
    return {
        "label": r.label,
        "is_current": r.label == current_label,
        "contributions": dec(r.contributions),
        "dividends": dec(r.dividends),
        "interest": dec(r.interest),
        "net_flow": dec(r.net_flow),
        "opening_value": dec(r.opening_value_eur),
        "closing_value": dec(r.closing_value_eur),
        "growth_pct": dec(r.growth_pct),
        "total_growth_compounded": dec(r.total_growth_compounded_eur),
        "period_growth_xirr": dec(r.yearly_growth_eur),
        **real_fields(r.growth_pct, r.label, index or {}),
    }


def build_for_ccy(
    session: Session,
    *,
    monthly: bool,
    ccy: str,
    context: ReadModelContext | None = None,
    fill_gaps: bool = False,
) -> dict[str, Any]:
    """Periods in one reporting currency (``EUR``/``USD``), oldest first."""
    ccy = ccy.upper()
    ctx = context or build_context(session)
    rows = aggregate(
        session,
        monthly=monthly,
        today=ctx.as_of,
        display_currency=ccy,
        fill_gaps=fill_gaps,
    )
    current = f"{ctx.as_of:%Y-%m}" if monthly else f"{ctx.as_of:%Y}"
    index = _hicp_index(session) if ccy == "EUR" else {}
    return {
        "ccy": ccy,
        "as_of": ctx.as_of.isoformat(),
        "granularity": "month" if monthly else "year",
        "rows": [_flat_row(r, ccy=ccy, current_label=current, index=index) for r in rows],
    }
