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
        CheckConstraint("shares IS NULL OR shares > 0", name="ck_recurring_plans_shares"),
        CheckConstraint(
            "provider IS NULL OR provider IN ('wise', 'revolut', 'other')",
            name="ck_recurring_plans_provider",
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
    # Buy plan.
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    instrument_id: Mapped[int | None] = mapped_column(
        ForeignKey("instruments.id", ondelete="CASCADE")
    )
    #: Buy: native amount per run (or ``shares``); conversion: EUR sent per run.
    amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    shares: Mapped[Decimal | None] = mapped_column(Numeric(18, 8))
    # Conversion plan.
    provider: Mapped[str | None] = mapped_column(String(16))
    expected_fee: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False), server_default=func.current_timestamp(), nullable=False
    )
