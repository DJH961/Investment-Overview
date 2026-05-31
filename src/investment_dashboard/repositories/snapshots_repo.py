"""Snapshots repository — persisted daily total portfolio value in EUR."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from investment_dashboard.models import PositionSnapshot


def get_snapshot(session: Session, snapshot_date: date) -> PositionSnapshot | None:
    return session.get(PositionSnapshot, snapshot_date)


def list_in_range(session: Session, start: date, end: date) -> list[PositionSnapshot]:
    """Return stored snapshots with ``start <= snapshot_date <= end``, oldest first.

    Used to chain true daily time-weighted returns over a period: the
    caller walks consecutive stored daily values and compounds each
    sub-period return, rather than approximating the whole period with a
    single Modified-Dietz flow.
    """
    stmt = (
        select(PositionSnapshot)
        .where(PositionSnapshot.snapshot_date >= start)
        .where(PositionSnapshot.snapshot_date <= end)
        .order_by(PositionSnapshot.snapshot_date)
    )
    return list(session.scalars(stmt).all())


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
