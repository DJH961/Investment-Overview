"""Target-allocation repository."""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from sqlalchemy import select, update
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
    """Mark one allocation active and all others inactive.

    Two bulk ``UPDATE``s instead of loading every allocation and flipping
    ``active`` in Python. ``synchronize_session="evaluate"`` keeps any ORM
    instances already loaded in this session consistent with the change.
    """
    session.execute(
        update(TargetAllocation)
        .where(TargetAllocation.id != allocation_id)
        .values(active=False),
        execution_options={"synchronize_session": "evaluate"},
    )
    session.execute(
        update(TargetAllocation)
        .where(TargetAllocation.id == allocation_id)
        .values(active=True),
        execution_options={"synchronize_session": "evaluate"},
    )
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
