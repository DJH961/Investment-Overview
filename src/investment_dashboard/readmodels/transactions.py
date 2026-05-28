"""Transactions read-model — raw ledger rows with optional USD column."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.ui.pages._ledger_query import (
    LedgerFilters,
    LedgerRecord,
    list_ledger_records,
)


def _record_dict(r: LedgerRecord) -> dict[str, Any]:
    return {
        "id": r.id,
        "date": r.date.isoformat(),
        "account": r.account_label,
        "kind": r.kind,
        "symbol": r.symbol,
        "quantity": dec(r.quantity),
        "price_native": dec(r.price_native),
        "fees_native": dec(r.fees_native),
        "gross_native": dec(r.gross_native),
        "net_native": dec(r.net_native),
        "net_eur": dec(r.net_eur),
        "net_usd": dec(r.net_usd),
        "source": r.source,
    }


def build(
    session: Session,
    *,
    context: ReadModelContext | None = None,
    filters: LedgerFilters | None = None,
) -> dict[str, Any]:
    """Return the JSON-serializable transactions read-model."""
    ctx = context or build_context(session)
    rows = list_ledger_records(session, filters, fx_rate=ctx.fx_rate_eur_usd)
    return {"rows": [_record_dict(r) for r in rows]}
