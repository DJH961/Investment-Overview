"""Transaction repository — ledger queries and inserts."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from investment_dashboard.domain.money_market import is_money_market
from investment_dashboard.models import Instrument, Transaction


def find_account_money_market_instrument(session: Session, account_id: int) -> Instrument | None:
    """Return the money-market settlement fund this account already holds.

    Detected from the distinct instruments the account has transacted in,
    using :func:`is_money_market` (known tickers or a "money market" name).
    Returns ``None`` when the account has no settlement fund yet, so callers
    can simply skip the auto-leg rather than inventing one.
    """
    stmt = (
        select(Instrument)
        .join(Transaction, Transaction.instrument_id == Instrument.id)
        .where(Transaction.account_id == account_id)
        .distinct()
    )
    for instrument in session.scalars(stmt):
        if is_money_market(
            instrument.symbol,
            asset_class=instrument.asset_class,
            name=instrument.name,
        ):
            return instrument
    return None


def list_transactions(
    session: Session,
    *,
    account_id: int | None = None,
    instrument_id: int | None = None,
    kinds: Sequence[str] | None = None,
    start: date | None = None,
    end: date | None = None,
) -> Sequence[Transaction]:
    """Filtered ledger listing, ordered by date asc then id asc."""
    stmt = select(Transaction)
    conds: list[Any] = []
    if account_id is not None:
        conds.append(Transaction.account_id == account_id)
    if instrument_id is not None:
        conds.append(Transaction.instrument_id == instrument_id)
    if kinds is not None:
        conds.append(Transaction.kind.in_(list(kinds)))
    if start is not None:
        conds.append(Transaction.date >= start)
    if end is not None:
        conds.append(Transaction.date <= end)
    if conds:
        stmt = stmt.where(and_(*conds))
    stmt = stmt.order_by(Transaction.date, Transaction.id)
    return session.scalars(stmt).all()


def list_transactions_missing_legs(session: Session) -> Sequence[Transaction]:
    """Rows still lacking a frozen FX leg (``net_eur`` or ``net_usd`` is NULL).

    Pushes the "needs backfill" predicate into the query instead of loading the
    whole ledger and filtering in Python (B6). Ordered like
    :func:`list_transactions` (date asc, id asc) so callers stay deterministic.
    """
    stmt = (
        select(Transaction)
        .where(or_(Transaction.net_eur.is_(None), Transaction.net_usd.is_(None)))
        .order_by(Transaction.date, Transaction.id)
    )
    return session.scalars(stmt).all()


def get_transaction(session: Session, txn_id: int) -> Transaction | None:
    return session.get(Transaction, txn_id)


def insert_transaction(session: Session, txn: Transaction) -> Transaction | None:
    """Insert ``txn``; return it on success, or ``None`` if it duplicates an
    existing ``(account_id, external_id)`` pair (dedup, spec §5.1).

    Uses a SAVEPOINT (``session.begin_nested``) so a duplicate row's
    constraint violation does **not** roll back the caller's transaction —
    only the failed insert is reverted.
    """
    nested = session.begin_nested()
    session.add(txn)
    try:
        session.flush()
    except IntegrityError:
        nested.rollback()
        return None
    nested.commit()
    return txn


def earliest_transaction_date(session: Session) -> date | None:
    stmt = select(Transaction.date).order_by(Transaction.date).limit(1)
    return session.scalars(stmt).one_or_none()


def update_transaction(session: Session, txn_id: int, **fields: Any) -> Transaction | None:
    """Update the given columns on transaction ``txn_id`` in place.

    Returns the refreshed row, or ``None`` if no such transaction exists. Only
    keys that map to real ``Transaction`` columns are applied; unknown keys are
    ignored so callers can pass a superset safely.
    """
    txn = session.get(Transaction, txn_id)
    if txn is None:
        return None
    for key, value in fields.items():
        if hasattr(txn, key):
            setattr(txn, key, value)
    session.flush()
    return txn


def delete_transaction(session: Session, txn_id: int) -> bool:
    """Delete transaction ``txn_id``; return ``True`` if a row was removed."""
    txn = session.get(Transaction, txn_id)
    if txn is None:
        return False
    session.delete(txn)
    session.flush()
    return True
