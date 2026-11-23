"""Recurring plans and their estimated rows (ledger tier, 7.3 P14)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import Any

from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.orm import Session

from investment_dashboard.domain.money_market import SETTLEMENT_EXTERNAL_ID_SUFFIX
from investment_dashboard.models import (
    FxConversion,
    RecurringPlan,
    RecurringPlanLeg,
    Transaction,
)

#: Plan kinds whose est. rows never ask the owner for anything (a fixed deposit has no
#: variation): they carry the flag so an import can update them (P15), but are left out of
#: "rows to settle", the badge and the Data Health check.
NEEDS_NO_INPUT_KINDS: tuple[str, ...] = ("deposit",)


def _own_estimate() -> ColumnElement[bool]:
    """An est. row that needs input: not a core-fund leg (confirmed with its parent) and
    not a kind in :data:`NEEDS_NO_INPUT_KINDS`."""
    return and_(
        or_(
            Transaction.external_id.is_(None),
            ~Transaction.external_id.like(f"%{SETTLEMENT_EXTERNAL_ID_SUFFIX}"),
        ),
        Transaction.kind.not_in(NEEDS_NO_INPUT_KINDS),
    )


def list_plans(session: Session) -> Sequence[RecurringPlan]:
    return session.scalars(select(RecurringPlan).order_by(RecurringPlan.id)).all()


def get_plan(session: Session, plan_id: int) -> RecurringPlan | None:
    return session.get(RecurringPlan, plan_id)


def add_plan(session: Session, **fields: Any) -> RecurringPlan:
    row = RecurringPlan(**fields)
    session.add(row)
    session.flush()
    session.refresh(row)
    return row


def update_plan(session: Session, row: RecurringPlan, **fields: Any) -> RecurringPlan:
    for key, value in fields.items():
        setattr(row, key, value)
    session.flush()
    return row


def delete_plan(session: Session, row: RecurringPlan) -> None:
    """Delete a plan; its generated rows stay (``estimate_plan_id`` -> NULL via the FK)."""
    session.execute(
        Transaction.__table__.update()
        .where(Transaction.estimate_plan_id == row.id)
        .values(estimate_plan_id=None)
    )
    session.execute(
        FxConversion.__table__.update()
        .where(FxConversion.estimate_plan_id == row.id)
        .values(estimate_plan_id=None)
    )
    for leg in list_legs(session, row.id):
        session.delete(leg)
    session.flush()
    session.expire_all()
    session.delete(row)
    session.flush()


def estimate_exists(session: Session, plan_id: int, due: date, leg_id: int = 0) -> bool:
    """Whether a row (estimated or settled) already exists for ``(plan, due date, leg)``."""
    txn = select(Transaction.id).where(
        Transaction.estimate_plan_id == plan_id,
        Transaction.estimate_due_date == due,
        Transaction.estimate_leg_id == leg_id,
    )
    conv = select(FxConversion.id).where(
        FxConversion.estimate_plan_id == plan_id, FxConversion.estimate_due_date == due
    )
    if session.scalar(txn) is not None:
        return True
    return leg_id == 0 and session.scalar(conv) is not None


def mark_estimate(
    row: Transaction | FxConversion, plan_id: int, due: date, leg_id: int = 0
) -> None:
    row.estimate_plan_id = plan_id
    row.estimate_due_date = due
    row.is_estimate = True
    if isinstance(row, Transaction):
        row.estimate_leg_id = leg_id


def list_legs(session: Session, plan_id: int) -> Sequence[RecurringPlanLeg]:
    stmt = (
        select(RecurringPlanLeg)
        .where(RecurringPlanLeg.plan_id == plan_id)
        .order_by(RecurringPlanLeg.position, RecurringPlanLeg.id)
    )
    return session.scalars(stmt).all()


def replace_legs(session: Session, plan_id: int, legs: Sequence[dict[str, Any]]) -> None:
    """Replace a plan's legs (new ids; est. rows already written keep the old leg id)."""
    for old in list_legs(session, plan_id):
        session.delete(old)
    session.flush()
    for position, leg in enumerate(legs):
        session.add(RecurringPlanLeg(plan_id=plan_id, position=position, **leg))
    session.flush()


def list_estimate_transactions(
    session: Session, *, due: date | None = None
) -> Sequence[Transaction]:
    stmt = select(Transaction).where(Transaction.is_estimate.is_(True), _own_estimate())
    if due is not None:
        stmt = stmt.where(Transaction.estimate_due_date == due)
    return session.scalars(stmt.order_by(Transaction.date, Transaction.id)).all()


def list_estimate_conversions(
    session: Session, *, due: date | None = None
) -> Sequence[FxConversion]:
    stmt = select(FxConversion).where(FxConversion.is_estimate.is_(True))
    if due is not None:
        stmt = stmt.where(FxConversion.estimate_due_date == due)
    return session.scalars(stmt.order_by(FxConversion.date, FxConversion.id)).all()


def count_estimates(session: Session) -> int:
    txns = select(func.count()).select_from(Transaction)
    convs = select(func.count()).select_from(FxConversion)
    return (session.scalar(txns.where(Transaction.is_estimate.is_(True), _own_estimate())) or 0) + (
        session.scalar(convs.where(FxConversion.is_estimate.is_(True))) or 0
    )


def list_real_conversions(session: Session, provider: str) -> Sequence[FxConversion]:
    """Past non-estimated conversions with ``provider``, oldest first."""
    stmt = (
        select(FxConversion)
        .where(FxConversion.provider == provider, FxConversion.is_estimate.is_(False))
        .order_by(FxConversion.date, FxConversion.id)
    )
    return session.scalars(stmt).all()


def get_transaction(session: Session, txn_id: int) -> Transaction | None:
    return session.get(Transaction, txn_id)


def get_conversion(session: Session, conversion_id: int) -> FxConversion | None:
    return session.get(FxConversion, conversion_id)
