"""Deposits read-model — contribution KPIs + raw cash-flow rows."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.queries.deposits_query import (
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
        "total_contrib_usd": dec(s.total_contrib_usd),
        "ytd_contrib_usd": dec(s.ytd_contrib_usd),
        "mtd_contrib_usd": dec(s.mtd_contrib_usd),
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


def build_for_ccy(
    session: Session,
    *,
    ccy: str,
    account_id: int | None = None,
    context: ReadModelContext | None = None,
) -> dict[str, Any]:
    """Deposits summary + rows in one reporting currency.

    ``amount`` is the frozen per-transaction leg in ``ccy`` (trade-date rate);
    ``None`` when that leg does not exist. Rows keep the native amount.
    """
    ccy = ccy.upper()
    ctx = context or build_context(session)
    summary = compute_summary(session, today=ctx.as_of)
    records = list_deposit_records(session, account_id=account_id)
    usd = ccy == "USD"
    return {
        "ccy": ccy,
        "as_of": ctx.as_of.isoformat(),
        "summary": {
            "total_contrib": dec(summary.total_contrib_usd if usd else summary.total_contrib_eur),
            "ytd_contrib": dec(summary.ytd_contrib_usd if usd else summary.ytd_contrib_eur),
            "mtd_contrib": dec(summary.mtd_contrib_usd if usd else summary.mtd_contrib_eur),
            "total_contrib_native": dec(summary.total_contrib_native),
        },
        "rows": [
            {
                "id": r.id,
                "date": r.date.isoformat(),
                "account": r.account_label,
                "kind": r.kind,
                "amount_native": dec(r.amount_native),
                "currency": r.native_currency,
                "amount": dec(r.amount_usd if usd else r.amount_eur),
                "description": r.description,
                "effective_rate": None,
                "rate_source": None,
            }
            for r in records
        ],
    }
