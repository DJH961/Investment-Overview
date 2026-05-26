"""Instrument repository — CRUD against the ``instruments`` table."""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.models import Instrument


def list_instruments(session: Session, *, only_active: bool = True) -> Sequence[Instrument]:
    stmt = select(Instrument).order_by(Instrument.symbol)
    if only_active:
        stmt = stmt.where(Instrument.active.is_(True))
    return session.scalars(stmt).all()


def get_by_symbol(session: Session, symbol: str) -> Instrument | None:
    stmt = select(Instrument).where(Instrument.symbol == symbol)
    return session.scalars(stmt).one_or_none()


def get_or_create(
    session: Session,
    *,
    symbol: str,
    name: str | None = None,
    asset_class: str = "etf",
    native_currency: str = "USD",
    category: str | None = None,
    expense_ratio: Decimal | None = None,
) -> Instrument:
    """Return existing instrument by symbol, or create a minimal stub.

    Used by CSV importers when they encounter an unknown symbol — the user
    can later fill in ``name``, ``category``, etc. from ``/settings``.
    """
    existing = get_by_symbol(session, symbol)
    if existing is not None:
        return existing
    instr = Instrument(
        symbol=symbol,
        name=name,
        asset_class=asset_class,
        native_currency=native_currency.upper(),
        category=category,
        expense_ratio=expense_ratio,
        active=True,
    )
    session.add(instr)
    session.flush()
    return instr


def update_instrument(
    session: Session,
    instrument_id: int,
    *,
    name: str | None = None,
    category: str | None = None,
    asset_class: str | None = None,
    active: bool | None = None,
) -> Instrument:
    """Update mutable display/classification fields on an instrument.

    ``symbol`` and ``native_currency`` are intentionally not mutable —
    they're foreign-keyed by price history and ledger entries.
    Raises ``ValueError`` if ``instrument_id`` does not exist.
    """
    instr = session.get(Instrument, instrument_id)
    if instr is None:
        raise ValueError(f"Instrument {instrument_id} not found")
    if name is not None:
        instr.name = name
    if category is not None:
        instr.category = category
    if asset_class is not None:
        instr.asset_class = asset_class
    if active is not None:
        instr.active = active
    session.flush()
    return instr
