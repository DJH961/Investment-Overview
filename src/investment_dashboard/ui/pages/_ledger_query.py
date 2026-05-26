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


def _fmt_decimal(value: Decimal | None, places: int = 2) -> str:
    if value is None:
        return ""
    quant = Decimal(10) ** -places
    return f"{value.quantize(quant):,}"


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

    txns = session.scalars(stmt).all()
    return [_to_row(t, fx_rate=fx_rate) for t in txns]


def _to_row(t: Transaction, *, fx_rate: Decimal | None = None) -> dict[str, Any]:
    account: Account | None = t.account  # type: ignore[assignment]
    instrument: Instrument | None = t.instrument  # type: ignore[assignment]
    net_usd: Decimal | None = None
    if fx_rate is not None and t.net_eur is not None:
        net_usd = t.net_eur * fx_rate
    return {
        "id": t.id,
        "date": t.date.isoformat(),
        "account": account.account_label if account else "",
        "kind": t.kind,
        "symbol": instrument.symbol if instrument else "",
        "qty": _fmt_decimal(t.quantity, 6),
        "price": _fmt_decimal(t.price_native, 4),
        "fees": _fmt_decimal(t.fees_native),
        "gross": _fmt_decimal(t.gross_native),
        "net": _fmt_decimal(t.net_native),
        "net_eur": _fmt_decimal(t.net_eur),
        "net_usd": _fmt_decimal(net_usd),
        "source": t.source,
    }
