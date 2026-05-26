"""Snapshots repository — persisted daily total portfolio value in EUR."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import PositionSnapshot


def get_snapshot(session: Session, snapshot_date: date) -> PositionSnapshot | None:
    return session.get(PositionSnapshot, snapshot_date)


def list_snapshots(
    session: Session,
    *,
    start: date | None = None,
    end: date | None = None,
) -> Sequence[PositionSnapshot]:
    """Return snapshots in ``[start, end]`` inclusive, oldest first."""
    stmt = select(PositionSnapshot).order_by(PositionSnapshot.snapshot_date)
    if start is not None:
        stmt = stmt.where(PositionSnapshot.snapshot_date >= start)
    if end is not None:
        stmt = stmt.where(PositionSnapshot.snapshot_date <= end)
    return session.scalars(stmt).all()


def upsert_snapshot(
    session: Session,
    snapshot_date: date,
    total_value_eur: Decimal,
) -> None:
    """Idempotent insert: today's row is rewritten on every refresh."""
    from datetime import UTC, datetime  # noqa: PLC0415

    stmt = sqlite_insert(PositionSnapshot).values(
        snapshot_date=snapshot_date,
        total_value_eur=total_value_eur,
        computed_at=datetime.now(UTC).replace(tzinfo=None),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[PositionSnapshot.snapshot_date],
        set_={
            "total_value_eur": stmt.excluded.total_value_eur,
            "computed_at": stmt.excluded.computed_at,
        },
    )
    session.execute(stmt)


def delete_from(session: Session, start: date) -> int:
    """Delete all snapshots on or after ``start``. Returns rows deleted.

    Used when the ledger is mutated and historical snapshots need a
    rebuild (any change to a transaction on/after ``start`` invalidates
    every cached value on/after that date).
    """
    stmt = select(PositionSnapshot).where(PositionSnapshot.snapshot_date >= start)
    rows = session.scalars(stmt).all()
    for row in rows:
        session.delete(row)
    return len(rows)
