"""Import batches (ledger tier): one row per confirmed import, plus its transactions."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from investment_dashboard.models import ImportBatch, Transaction
from investment_dashboard.models.import_batch import BATCH_ACTIVE, BATCH_UNDONE

__all__ = ["BATCH_ACTIVE", "BATCH_UNDONE"]


def create(
    session: Session,
    *,
    created_at: datetime,
    account_id: int,
    broker: str,
    filename: str,
    actor: str | None,
) -> ImportBatch:
    batch = ImportBatch(
        created_at=created_at,
        account_id=account_id,
        broker=broker,
        filename=filename[:256],
        row_count=0,
        duplicate_count=0,
        status=BATCH_ACTIVE,
        actor=actor,
    )
    session.add(batch)
    session.flush()
    return batch


def get(session: Session, batch_id: int) -> ImportBatch | None:
    return session.get(ImportBatch, batch_id)


def list_recent(session: Session, *, limit: int = 100) -> Sequence[ImportBatch]:
    stmt = select(ImportBatch).order_by(ImportBatch.created_at.desc(), ImportBatch.id.desc())
    return session.scalars(stmt.limit(limit)).all()


def current_row_counts(session: Session, batch_ids: Sequence[int]) -> dict[int, int]:
    """``{batch_id: transactions still attached}`` (edited / deleted rows are gone)."""
    if not batch_ids:
        return {}
    stmt = (
        select(Transaction.import_batch_id, func.count(Transaction.id))
        .where(Transaction.import_batch_id.in_(list(batch_ids)))
        .group_by(Transaction.import_batch_id)
    )
    return {int(b): int(n) for b, n in session.execute(stmt).all() if b is not None}


def transactions_of(session: Session, batch_id: int) -> Sequence[Transaction]:
    stmt = (
        select(Transaction)
        .where(Transaction.import_batch_id == batch_id)
        .order_by(Transaction.date, Transaction.id)
    )
    return session.scalars(stmt).all()


def delete_transactions_of(session: Session, batch_id: int) -> tuple[int, set[date]]:
    """Delete every transaction attached to ``batch_id``; ``(count, their dates)``."""
    rows = list(transactions_of(session, batch_id))
    dates = {t.date for t in rows}
    for txn in rows:
        session.delete(txn)
    session.flush()
    return len(rows), dates


def mark_undone(
    session: Session,
    batch: ImportBatch,
    *,
    at: datetime,
    actor: str,
    rows: int,
    backup: str | None,
) -> None:
    batch.status = BATCH_UNDONE
    batch.undone_at = at
    batch.undone_by = actor
    batch.undone_rows = rows
    batch.backup = backup
    session.flush()


def detach(session: Session, txn_ids: Sequence[int]) -> None:
    """Take transactions out of their batch (a manual edit makes them the user's)."""
    if not txn_ids:
        return
    session.execute(
        update(Transaction).where(Transaction.id.in_(list(txn_ids))).values(import_batch_id=None)
    )
    session.flush()
