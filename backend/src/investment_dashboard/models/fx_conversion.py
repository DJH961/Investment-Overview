"""FX conversion batches (ledger tier).

One row per EUR -> USD batch: date, EUR sent, USD received, optional fees, note.
Amounts are native; the effective rate ``usd_received / eur_sent`` is derived.
Migration revision ``d2a6b4c8e1f0`` (down_revision ``c1f5a3b9e2d4``).
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, DateTime, Index, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import LedgerBase as Base


class FxConversion(Base):
    __tablename__ = "fx_conversions"
    __table_args__ = (
        CheckConstraint("eur_sent > 0", name="ck_fx_conversions_eur_pos"),
        CheckConstraint("usd_received > 0", name="ck_fx_conversions_usd_pos"),
        Index("ix_fx_conversions_date", "date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    eur_sent: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    usd_received: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    fees_eur: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    note: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False), server_default=func.current_timestamp(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
        nullable=False,
    )
