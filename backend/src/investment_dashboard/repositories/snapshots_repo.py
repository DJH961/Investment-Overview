"""Snapshots repository — persisted daily total portfolio value in EUR."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import delete, select
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
    total_value_usd: Decimal | None = None,
    fx_eur_usd: Decimal | None = None,
) -> None:
    """Idempotent insert: today's row is rewritten on every refresh.

    ``total_value_usd`` + ``fx_eur_usd`` are the native USD total and the
    per-instant rate; readers derive EUR as ``usd / fx`` when both are set.
    """
    from datetime import UTC, datetime  # noqa: PLC0415

    stmt = sqlite_insert(PositionSnapshot).values(
        snapshot_date=snapshot_date,
        total_value_eur=total_value_eur,
        total_value_usd=total_value_usd,
        fx_eur_usd=fx_eur_usd,
        computed_at=datetime.now(UTC).replace(tzinfo=None),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[PositionSnapshot.snapshot_date],
        set_={
            "total_value_eur": stmt.excluded.total_value_eur,
            "total_value_usd": stmt.excluded.total_value_usd,
            "fx_eur_usd": stmt.excluded.fx_eur_usd,
            "computed_at": stmt.excluded.computed_at,
        },
    )
    session.execute(stmt)


def list_missing_usd(session: Session, limit: int) -> list[date]:
    """Dates of stored snapshots without a native USD total (pre-0017 rows), oldest first."""
    stmt = (
        select(PositionSnapshot.snapshot_date)
        .where(PositionSnapshot.total_value_usd.is_(None))
        .order_by(PositionSnapshot.snapshot_date)
        .limit(limit)
    )
    return list(session.scalars(stmt).all())


def fill_usd(
    session: Session, snapshot_date: date, total_value_usd: Decimal, fx_eur_usd: Decimal
) -> bool:
    """Set the native USD total (and the rate when absent) of an existing row.

    Never touches ``total_value_eur``. Returns whether a row was updated.
    """
    row = session.get(PositionSnapshot, snapshot_date)
    if row is None or row.total_value_usd is not None:
        return False
    row.total_value_usd = total_value_usd
    if not row.fx_eur_usd:
        row.fx_eur_usd = fx_eur_usd
    session.flush()
    return True


def delete_from(session: Session, start: date) -> int:
    """Delete all snapshots on or after ``start``. Returns rows deleted.

    Used when the ledger is mutated and historical snapshots need a
    rebuild (any change to a transaction on/after ``start`` invalidates
    every cached value on/after that date).
    """
    stmt = delete(PositionSnapshot).where(PositionSnapshot.snapshot_date >= start)
    result = session.execute(stmt)
    return int(result.rowcount or 0)
