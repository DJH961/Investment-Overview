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

from investment_dashboard.domain.currency import dual_currency_amounts
from investment_dashboard.models import Account, Instrument, Transaction
from investment_dashboard.services import fx_service
from investment_dashboard.ui.money_format import currency_symbol, fmt_shares


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
    native_currency: str
    quantity: Decimal | None
    price_native: Decimal | None
    fees_native: Decimal | None
    gross_native: Decimal | None
    net_native: Decimal | None
    net_eur: Decimal | None
    net_usd: Decimal | None
    source: str | None


def _fmt_money(value: Decimal | None, currency: str, places: int = 2) -> str:
    """Format a currency value with its symbol and a fixed 2-decimal (cent) scale."""
    if value is None:
        return ""
    quant = Decimal(10) ** -places
    return f"{currency_symbol(currency)}{value.quantize(quant):,}"


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

    Both ``net_eur`` and ``net_usd`` are derived from the EUR→USD rate that
    was in force **on each transaction's own date** (forward-filled), so the
    non-native side reflects the exchange rate of the day the trade happened
    rather than today's spot. ``fx_rate`` (current EUR→USD) is only used as a
    fallback when a row predates the available FX history.
    """
    txns = session.scalars(_build_ledger_stmt(filters)).all()
    eur_to_usd = fx_service.get_rates(session, base="EUR", quote="USD")
    return [_to_record(t, eur_to_usd=eur_to_usd, fallback_rate=fx_rate) for t in txns]


def list_ledger_rows(
    session: Session,
    filters: LedgerFilters | None = None,
    *,
    fx_rate: Decimal | None = None,
) -> list[dict[str, Any]]:
    """Return ledger rows in newest-first order, ready to hand to AG-Grid.

    ``net_eur`` and ``net_usd`` are both populated per the trade-date FX rate
    (see :func:`list_ledger_records`); ``fx_rate`` is the current EUR→USD spot
    used only as a fallback for rows older than the FX history.
    """
    return [_format_record(r) for r in list_ledger_records(session, filters, fx_rate=fx_rate)]


@dataclass(frozen=True)
class LedgerSummary:
    """Top-of-page KPI numbers for the Transactions ledger.

    ``avg_trade_size_*`` is the mean absolute net amount across *trade*
    rows (buys + sells), which is the figure users intuitively read as
    "average trade size"; cash-only rows are excluded so a string of
    small deposits doesn't drag the number down.
    """

    count: int
    buy_count: int
    sell_count: int
    avg_trade_size_eur: Decimal
    avg_trade_size_usd: Decimal


def summarize_ledger(
    session: Session,
    filters: LedgerFilters | None = None,
    *,
    fx_rate: Decimal | None = None,
) -> LedgerSummary:
    """Aggregate KPI figures for the (optionally filtered) ledger."""
    records = list_ledger_records(session, filters, fx_rate=fx_rate)
    count = len(records)
    buy_count = sum(1 for r in records if r.kind == "buy")
    sell_count = sum(1 for r in records if r.kind == "sell")
    trades = [r for r in records if r.kind in ("buy", "sell")]
    eur_amounts = [abs(r.net_eur) for r in trades if r.net_eur is not None]
    usd_amounts = [abs(r.net_usd) for r in trades if r.net_usd is not None]
    avg_eur = (sum(eur_amounts, Decimal(0)) / len(eur_amounts)) if eur_amounts else Decimal(0)
    avg_usd = (sum(usd_amounts, Decimal(0)) / len(usd_amounts)) if usd_amounts else Decimal(0)
    return LedgerSummary(
        count=count,
        buy_count=buy_count,
        sell_count=sell_count,
        avg_trade_size_eur=avg_eur,
        avg_trade_size_usd=avg_usd,
    )


def _to_record(
    t: Transaction,
    *,
    eur_to_usd: dict[date, Decimal] | None = None,
    fallback_rate: Decimal | None = None,
) -> LedgerRecord:
    account: Account | None = t.account  # type: ignore[assignment]
    instrument: Instrument | None = t.instrument  # type: ignore[assignment]

    # Derive both currency legs from the FX rate on the transaction's own
    # date. The native side is the booked amount; the other side is converted
    # at the trade-date rate so e.g. a USD buy shows the EUR it actually cost
    # that day rather than today's spot. ``fallback_rate`` (current spot) only
    # kicks in for rows older than the available FX history.
    native_ccy = (account.native_currency if account else "").upper()
    net_eur, net_usd = dual_currency_amounts(
        native_currency=native_ccy,
        net_native=t.net_native,
        net_eur=t.net_eur,
        net_usd=t.net_usd,
        on=t.date,
        eur_to_usd=eur_to_usd or {},
        fallback_rate=fallback_rate,
    )
    return LedgerRecord(
        id=t.id,
        date=t.date,
        account_label=account.account_label if account else "",
        kind=t.kind,
        symbol=instrument.symbol if instrument else "",
        native_currency=native_ccy,
        quantity=t.quantity,
        price_native=t.price_native,
        fees_native=t.fees_native,
        gross_native=t.gross_native,
        net_native=t.net_native,
        net_eur=net_eur,
        net_usd=net_usd,
        source=t.source,
    )


def _format_record(r: LedgerRecord) -> dict[str, Any]:
    ccy = r.native_currency
    return {
        "id": r.id,
        "date": r.date.isoformat(),
        "account": r.account_label,
        "kind": r.kind,
        "symbol": r.symbol,
        "qty": fmt_shares(r.quantity),
        "price": _fmt_money(r.price_native, ccy),
        "fees": _fmt_money(r.fees_native, ccy),
        "gross": _fmt_money(r.gross_native, ccy),
        "net": _fmt_money(r.net_native, ccy),
        "net_eur": _fmt_money(r.net_eur, "EUR"),
        "net_usd": _fmt_money(r.net_usd, "USD"),
        "source": r.source,
    }
