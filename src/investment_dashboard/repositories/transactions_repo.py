"""Transaction repository — ledger queries and inserts."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import Any

from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction


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
