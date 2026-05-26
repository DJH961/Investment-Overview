"""Daily portfolio-value snapshot — cache for /overview, /monthly, /yearly.

Stores the EUR mark-to-market total for the whole portfolio on a given
date. Today's row is overwritten in place as fresh prices arrive; older
days are written once and kept for fast period-bucket roll-ups.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, Numeric
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from investment_dashboard.models.base import Base


class PositionSnapshot(Base):
    """One row per calendar date — the total portfolio value in EUR."""

    __tablename__ = "position_snapshots"

    snapshot_date: Mapped[date] = mapped_column(Date, primary_key=True)
    total_value_eur: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<PositionSnapshot {self.snapshot_date} = €{self.total_value_eur}>"
