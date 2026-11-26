"""Recurring plans (7.3, P14): a buy or an EUR->USD conversion repeated on a cadence.

A plan only describes the schedule; the rows it produces are ordinary
``transactions`` / ``fx_conversions`` rows flagged ``is_estimate`` and keyed by
``(estimate_plan_id, estimate_due_date)``. Migration ``0027``.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import LedgerBase as Base


class RecurringPlan(Base):
    __tablename__ = "recurring_plans"
    __table_args__ = (
        CheckConstraint("kind IN ('buy', 'deposit', 'conversion')", name="ck_recurring_plans_kind"),
        CheckConstraint("unit IN ('days', 'weeks', 'months')", name="ck_recurring_plans_unit"),
        CheckConstraint("every >= 1", name="ck_recurring_plans_every"),
        CheckConstraint("amount IS NULL OR amount > 0", name="ck_recurring_plans_amount"),
        CheckConstraint(
            "provider IS NULL OR provider IN ('wise', 'revolut', 'other')",
            name="ck_recurring_plans_provider",
        ),
        CheckConstraint(
            "currency IS NULL OR currency IN ('EUR', 'USD')",
            name="ck_recurring_plans_currency",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    #: Cadence: every ``every`` days / weeks / months.
    unit: Mapped[str] = mapped_column(String(8), nullable=False)
    every: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Weekday 0-6 (Mon=0) for weeks, day of month 1-31 for months; ``NULL`` = start date's.
    anchor: Mapped[int | None] = mapped_column(Integer)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date | None] = mapped_column(Date)
    paused: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("0"), default=False
    )
    #: Due dates up to here were already handled (so a deleted est. row stays deleted).
    generated_through: Mapped[date | None] = mapped_column(Date)
    # Buy and deposit plans: the broker account (a buy plan's holdings are its legs).
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    #: Deposit: USD per run; conversion: EUR sent or USD arriving per run. Buy plans use their legs.
    amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    # Conversion plan.
    currency: Mapped[str | None] = mapped_column(String(3))
    provider: Mapped[str | None] = mapped_column(String(16))
    expected_fee: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False), server_default=func.current_timestamp(), nullable=False
    )


class RecurringPlanLeg(Base):
    """One holding a buy plan buys on every due date (amount or shares, same account)."""

    __tablename__ = "recurring_plan_legs"
    __table_args__ = (
        CheckConstraint("amount IS NULL OR amount > 0", name="ck_recurring_plan_legs_amount"),
        CheckConstraint("shares IS NULL OR shares > 0", name="ck_recurring_plan_legs_shares"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(
        ForeignKey("recurring_plans.id", ondelete="CASCADE"), nullable=False, index=True
    )
    instrument_id: Mapped[int] = mapped_column(
        ForeignKey("instruments.id", ondelete="CASCADE"), nullable=False
    )
    amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    shares: Mapped[Decimal | None] = mapped_column(Numeric(18, 8))
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
