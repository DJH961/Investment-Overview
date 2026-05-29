"""Deposits read-model — contribution KPIs + raw cash-flow rows."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.ui.pages._deposits_query import (
    DepositRecord,
    DepositSummary,
    compute_summary,
    list_deposit_records,
)


def _summary_dict(s: DepositSummary) -> dict[str, Any]:
    return {
        "total_contrib_native": dec(s.total_contrib_native),
        "total_contrib_eur": dec(s.total_contrib_eur),
        "ytd_contrib_eur": dec(s.ytd_contrib_eur),
        "mtd_contrib_eur": dec(s.mtd_contrib_eur),
        "interest_ytd_eur": dec(s.interest_ytd_eur),
        "total_contrib_usd": dec(s.total_contrib_usd),
        "ytd_contrib_usd": dec(s.ytd_contrib_usd),
        "mtd_contrib_usd": dec(s.mtd_contrib_usd),
        "interest_ytd_usd": dec(s.interest_ytd_usd),
    }


def _record_dict(r: DepositRecord) -> dict[str, Any]:
    return {
        "id": r.id,
        "date": r.date.isoformat(),
        "account": r.account_label,
        "kind": r.kind,
        "amount_native": dec(r.amount_native),
        "currency": r.native_currency,
        "amount_eur": dec(r.amount_eur),
        "amount_usd": dec(r.amount_usd) if r.amount_usd is not None else None,
        "description": r.description,
    }


def build(session: Session, *, context: ReadModelContext | None = None) -> dict[str, Any]:
    """Return the JSON-serializable deposits read-model."""
    ctx = context or build_context(session)
    summary = compute_summary(session, today=ctx.as_of)
    rows = list_deposit_records(session)
    return {
        "summary": _summary_dict(summary),
        "rows": [_record_dict(r) for r in rows],
    }
