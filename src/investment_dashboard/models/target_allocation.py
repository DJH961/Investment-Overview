"""Target allocations and their per-instrument weights.

Per spec §4.1: only one ``TargetAllocation`` should have ``active=True`` at
a time. The UI enforces this; we don't add a partial unique index here so
SQLite stays portable.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from investment_dashboard.models.base import Base

if TYPE_CHECKING:
    from investment_dashboard.models.instrument import Instrument


class TargetAllocation(Base):
    __tablename__ = "target_allocations"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        server_default=func.current_timestamp(),
        nullable=False,
    )

    items: Mapped[list[TargetAllocationItem]] = relationship(
        back_populates="allocation",
        cascade="all, delete-orphan",
    )


class TargetAllocationItem(Base):
    __tablename__ = "target_allocation_items"

    target_allocation_id: Mapped[int] = mapped_column(
        ForeignKey("target_allocations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    instrument_id: Mapped[int] = mapped_column(
        ForeignKey("instruments.id", ondelete="RESTRICT"),
        primary_key=True,
    )
    weight_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)

    allocation: Mapped[TargetAllocation] = relationship(back_populates="items")
    instrument: Mapped[Instrument] = relationship()
