"""FX conversion batches (ledger tier).

One row per EUR -> USD batch: date, EUR sent, USD received, optional fees, note.
Amounts are native; the effective rate ``usd_received / eur_sent`` is derived.
Migration revision ``d2a6b4c8e1f0`` (down_revision ``c1f5a3b9e2d4``).
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
    Index,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, synonym

from investment_dashboard.models.base import LedgerBase as Base


class FxConversion(Base):
    __tablename__ = "fx_conversions"
    __table_args__ = (
        CheckConstraint("eur_sent > 0", name="ck_fx_conversions_eur_pos"),
        CheckConstraint("usd_received > 0", name="ck_fx_conversions_usd_pos"),
        CheckConstraint(
            "provider IS NULL OR provider IN ('wise', 'revolut', 'other')",
            name="ck_fx_conversions_provider",
        ),
        UniqueConstraint(
            "estimate_plan_id", "estimate_due_date", name="uq_fx_conversions_estimate_plan_due"
        ),
        Index("ix_fx_conversions_date", "date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    eur_sent: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    usd_received: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    fees_eur: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    note: Mapped[str | None] = mapped_column(String(512))
    #: 7.3 generic pair (matching only knows EUR -> USD for now).
    from_ccy: Mapped[str] = mapped_column(String(3), nullable=False, server_default="EUR")
    to_ccy: Mapped[str] = mapped_column(String(3), nullable=False, server_default="USD")
    provider: Mapped[str | None] = mapped_column(String(16))
    #: Recurring-plan estimate (7.3, P14), as on ``transactions``.
    estimate_plan_id: Mapped[int | None] = mapped_column(
        ForeignKey("recurring_plans.id", ondelete="SET NULL")
    )
    estimate_due_date: Mapped[date | None] = mapped_column(Date)
    is_estimate: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("0"), default=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False), server_default=func.current_timestamp(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
        nullable=False,
    )

    # Generic names for new code (the EUR/USD columns stay: 7.2 reads them).
    amount_sent = synonym("eur_sent")
    amount_received = synonym("usd_received")
    fees = synonym("fees_eur")


class FxConversionPin(Base):
    """An owner-chosen link: pay ``usd`` of a deposit from one conversion (7.3)."""

    __tablename__ = "fx_conversion_pins"
    __table_args__ = (
        CheckConstraint("usd > 0", name="ck_fx_conversion_pins_usd_pos"),
        UniqueConstraint("deposit_txn_id", "conversion_id", name="uq_fx_conversion_pins_pair"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    deposit_txn_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    conversion_id: Mapped[int] = mapped_column(
        ForeignKey("fx_conversions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    usd: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False), server_default=func.current_timestamp(), nullable=False
    )
