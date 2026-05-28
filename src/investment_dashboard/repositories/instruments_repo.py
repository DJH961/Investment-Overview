"""Instrument repository — CRUD against the ledger-tier ``instruments`` table.

The user-tier annotations (``category``, ``active``) live in
``instrument_overrides`` on the config tier and are written through
:mod:`investment_dashboard.repositories.instrument_overrides_repo`.
This module deliberately does not touch them — keeping the ledger-tier
repo unaware of the override surface means callers can never
accidentally write an override through a ledger session.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.models import Instrument


def list_instruments(session: Session) -> Sequence[Instrument]:
    """Return every instrument, ordered by symbol.

    The ``active`` filter previously offered by this function moved to
    the config tier; callers that want only the user-active rows
    compose with ``instrument_overrides_repo.inactive_ids(config_session)``
    and skip those ids in Python. See e.g. ``prices_service``.
    """
    stmt = select(Instrument).order_by(Instrument.symbol)
    return session.scalars(stmt).all()


def get_by_symbol(session: Session, symbol: str) -> Instrument | None:
    stmt = select(Instrument).where(Instrument.symbol == symbol)
    return session.scalars(stmt).one_or_none()


def get_or_create(
    session: Session,
    *,
    symbol: str,
    name: str | None = None,
    asset_class: str = "unknown",
    native_currency: str = "USD",
    expense_ratio: Decimal | None = None,
) -> Instrument:
    """Return existing instrument by symbol, or create a minimal stub.

    Used by CSV importers when they encounter an unknown symbol. The
    default ``asset_class`` is ``"unknown"`` (v2.2 phase (b)) so the
    enrichment service can decide the real taxonomy from
    yfinance's ``quoteType`` — the v2.1 behaviour of hard-coding
    ``"etf"`` mis-classified every stock, mutual fund, and index that
    came in via a CSV.
    """
    existing = get_by_symbol(session, symbol)
    if existing is not None:
        return existing
    instr = Instrument(
        symbol=symbol,
        name=name,
        asset_class=asset_class,
        native_currency=native_currency.upper(),
        expense_ratio=expense_ratio,
    )
    session.add(instr)
    session.flush()
    return instr


def update_instrument(
    session: Session,
    instrument_id: int,
    *,
    name: str | None = None,
    asset_class: str | None = None,
    expense_ratio: Decimal | None = None,
) -> Instrument:
    """Update mutable ledger-tier fields on an instrument.

    ``symbol`` and ``native_currency`` are intentionally not mutable —
    they're loose-referenced by price history and ledger entries.
    ``category`` and ``active`` are config-tier and live in
    ``instrument_overrides``; this function does not accept them.
    Raises ``ValueError`` if ``instrument_id`` does not exist.
    """
    instr = session.get(Instrument, instrument_id)
    if instr is None:
        raise ValueError(f"Instrument {instrument_id} not found")
    if name is not None:
        instr.name = name
    if asset_class is not None:
        instr.asset_class = asset_class
    if expense_ratio is not None:
        instr.expense_ratio = expense_ratio
    session.flush()
    return instr
