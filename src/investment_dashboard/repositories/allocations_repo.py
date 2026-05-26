"""Target-allocation repository."""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from investment_dashboard.models import TargetAllocation, TargetAllocationItem


def list_allocations(session: Session) -> Sequence[TargetAllocation]:
    stmt = (
        select(TargetAllocation)
        .options(selectinload(TargetAllocation.items))
        .order_by(TargetAllocation.created_at.desc())
    )
    return session.scalars(stmt).all()


def get_active(session: Session) -> TargetAllocation | None:
    stmt = (
        select(TargetAllocation)
        .options(selectinload(TargetAllocation.items))
        .where(TargetAllocation.active.is_(True))
        .limit(1)
    )
    return session.scalars(stmt).one_or_none()


def set_active(session: Session, allocation_id: int) -> None:
    """Mark one allocation active and all others inactive."""
    for alloc in session.scalars(select(TargetAllocation)).all():
        alloc.active = alloc.id == allocation_id
    session.flush()


def create_allocation(
    session: Session,
    name: str,
    weights_by_instrument_id: dict[int, Decimal],
    *,
    active: bool = False,
) -> TargetAllocation:
    alloc = TargetAllocation(name=name, active=active)
    session.add(alloc)
    session.flush()
    for instrument_id, weight in weights_by_instrument_id.items():
        session.add(
            TargetAllocationItem(
                target_allocation_id=alloc.id,
                instrument_id=instrument_id,
                weight_pct=weight,
            )
        )
    if active:
        set_active(session, alloc.id)
    session.flush()
    return alloc
