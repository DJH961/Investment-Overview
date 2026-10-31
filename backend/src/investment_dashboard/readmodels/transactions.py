"""Transactions read-model — raw ledger rows with optional USD column."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._context import ReadModelContext, build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.queries.ledger_query import (
    LedgerFilters,
    LedgerRecord,
    count_ledger_records,
    get_ledger_record,
    list_ledger_records,
    summarize_ledger,
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


def _detail_dict(r: LedgerRecord) -> dict[str, Any]:
    """The full row used by the v6 API (list rows and the edit form)."""
    return {
        "id": r.id,
        "date": r.date.isoformat(),
        "settlement_date": r.settlement_date.isoformat() if r.settlement_date else None,
        "account_id": r.account_id,
        "account": r.account_label,
        "instrument_id": r.instrument_id,
        "kind": r.kind,
        "symbol": r.symbol,
        "currency": r.native_currency,
        "quantity": dec(r.quantity),
        "price_native": dec(r.price_native),
        "fees_native": dec(r.fees_native),
        "gross_native": dec(r.gross_native),
        "net_native": dec(r.net_native),
        "net_eur": dec(r.net_eur),
        "net_usd": dec(r.net_usd),
        "source": r.source,
        "description": r.description,
        "external_id": r.external_id,
        "is_settlement_leg": r.is_settlement_leg,
        "fx_incomplete": r.fx_incomplete,
    }


def build_page(
    session: Session,
    *,
    context: ReadModelContext | None = None,
    filters: LedgerFilters | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """Paged transactions (newest first) with a filter-wide summary."""
    ctx = context or build_context(session)
    rows = list_ledger_records(
        session, filters, fx_rate=ctx.fx_rate_eur_usd, limit=limit, offset=offset
    )
    summary = summarize_ledger(session, filters, fx_rate=ctx.fx_rate_eur_usd)
    return {
        "summary": {
            "count": summary.count,
            "buy_count": summary.buy_count,
            "sell_count": summary.sell_count,
            "avg_trade_size_eur": dec(summary.avg_trade_size_eur),
            "avg_trade_size_usd": dec(summary.avg_trade_size_usd),
        },
        "rows": [_detail_dict(r) for r in rows],
        "total": count_ledger_records(session, filters),
        "limit": limit,
        "offset": offset,
    }


def build_one(session: Session, txn_id: int) -> dict[str, Any] | None:
    """One transaction in the detail shape, or ``None`` if it doesn't exist."""
    ctx = build_context(session)
    record = get_ledger_record(session, txn_id, fx_rate=ctx.fx_rate_eur_usd)
    return None if record is None else _detail_dict(record)
