"""Target allocations and their per-instrument weights.

Belongs to the **config** tier. The ``instrument_id`` column references
the ledger-tier ``instruments`` table by integer only; SQLAlchemy
``ForeignKey`` cannot bridge separate ``MetaData`` instances, and
Phase 2 of the DB split puts each tier on its own SQLite file where
cross-file FKs are not enforceable. Application-level checks (the repo
validates the instrument exists before insert) take that role.

Per spec §4.1: only one ``TargetAllocation`` should have ``active=True``
at a time. The UI enforces this; we don't add a partial unique index
here so SQLite stays portable.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from investment_dashboard.models.base import ConfigBase as Base


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
    # Loose reference to ``instruments.id`` (ledger tier). Validated by
    # the allocation repository, not by a DB-level constraint.
    instrument_id: Mapped[int] = mapped_column(primary_key=True)
    weight_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)

    allocation: Mapped[TargetAllocation] = relationship(back_populates="items")
