"""Presentation-layer query: ledger rows shaped for the ``/transactions``
AG-Grid table.

Lives next to the page (not in `repositories/`) because it joins three
ORM models into a UI-shaped dict. Keeping it here also makes it easy to
unit-test without spinning up NiceGUI.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from investment_dashboard.models import Account, Instrument, Transaction


@dataclass(frozen=True)
class LedgerFilters:
    """User-selected filters from the page's UI controls."""

    account_id: int | None = None
    instrument_symbol: str | None = None
    kind: str | None = None
    source: str | None = None
    start: date | None = None
    end: date | None = None


@dataclass(frozen=True)
class LedgerRecord:
    """Raw (unformatted) ledger row — presentation-free counterpart of the
    dicts returned by :func:`list_ledger_rows`.
    """

    id: int | None
    date: date
    account_label: str
    kind: str
    symbol: str
    quantity: Decimal | None
    price_native: Decimal | None
    fees_native: Decimal | None
    gross_native: Decimal | None
    net_native: Decimal | None
    net_eur: Decimal | None
    net_usd: Decimal | None
    source: str | None


def _fmt_decimal(value: Decimal | None, places: int = 2) -> str:
    if value is None:
        return ""
    quant = Decimal(10) ** -places
    return f"{value.quantize(quant):,}"


def _build_ledger_stmt(filters: LedgerFilters | None):  # type: ignore[no-untyped-def]
    f = filters or LedgerFilters()
    stmt = (
        select(Transaction)
        .options(joinedload(Transaction.account), joinedload(Transaction.instrument))
        .order_by(Transaction.date.desc(), Transaction.id.desc())
    )
    if f.account_id is not None:
        stmt = stmt.where(Transaction.account_id == f.account_id)
    if f.kind:
        stmt = stmt.where(Transaction.kind == f.kind)
    if f.source:
        stmt = stmt.where(Transaction.source == f.source)
    if f.start is not None:
        stmt = stmt.where(Transaction.date >= f.start)
    if f.end is not None:
        stmt = stmt.where(Transaction.date <= f.end)
    if f.instrument_symbol:
        stmt = stmt.join(Transaction.instrument).where(Instrument.symbol == f.instrument_symbol)
    return stmt


def list_ledger_records(
    session: Session,
    filters: LedgerFilters | None = None,
    *,
    fx_rate: Decimal | None = None,
) -> list[LedgerRecord]:
    """Return raw ledger records in newest-first order.

    ``fx_rate`` is the current EUR→USD conversion factor (USD per 1 EUR);
    when provided ``net_usd`` is populated alongside ``net_eur``.
    """
    txns = session.scalars(_build_ledger_stmt(filters)).all()
    return [_to_record(t, fx_rate=fx_rate) for t in txns]


def list_ledger_rows(
    session: Session,
    filters: LedgerFilters | None = None,
    *,
    fx_rate: Decimal | None = None,
) -> list[dict[str, Any]]:
    """Return ledger rows in newest-first order, ready to hand to AG-Grid.

    ``fx_rate`` is the current EUR→USD conversion factor (USD per 1 EUR).
    When provided, an extra ``net_usd`` column is populated alongside
    ``net_eur`` so the transactions page can show both currencies.
    """
    return [_format_record(r) for r in list_ledger_records(session, filters, fx_rate=fx_rate)]


def _to_record(t: Transaction, *, fx_rate: Decimal | None = None) -> LedgerRecord:
    account: Account | None = t.account  # type: ignore[assignment]
    instrument: Instrument | None = t.instrument  # type: ignore[assignment]
    net_usd: Decimal | None = None
    if fx_rate is not None and t.net_eur is not None:
        net_usd = t.net_eur * fx_rate
    return LedgerRecord(
        id=t.id,
        date=t.date,
        account_label=account.account_label if account else "",
        kind=t.kind,
        symbol=instrument.symbol if instrument else "",
        quantity=t.quantity,
        price_native=t.price_native,
        fees_native=t.fees_native,
        gross_native=t.gross_native,
        net_native=t.net_native,
        net_eur=t.net_eur,
        net_usd=net_usd,
        source=t.source,
    )


def _format_record(r: LedgerRecord) -> dict[str, Any]:
    return {
        "id": r.id,
        "date": r.date.isoformat(),
        "account": r.account_label,
        "kind": r.kind,
        "symbol": r.symbol,
        "qty": _fmt_decimal(r.quantity, 6),
        "price": _fmt_decimal(r.price_native, 4),
        "fees": _fmt_decimal(r.fees_native),
        "gross": _fmt_decimal(r.gross_native),
        "net": _fmt_decimal(r.net_native),
        "net_eur": _fmt_decimal(r.net_eur),
        "net_usd": _fmt_decimal(r.net_usd),
        "source": r.source,
    }
