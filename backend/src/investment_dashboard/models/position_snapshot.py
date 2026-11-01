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

from investment_dashboard.models.base import CacheBase as Base


class PositionSnapshot(Base):
    """One row per calendar date — the total portfolio value in EUR."""

    __tablename__ = "position_snapshots"

    snapshot_date: Mapped[date] = mapped_column(Date, primary_key=True)
    total_value_eur: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    # Native USD total + the EUR->USD rate (USD per EUR) at that instant. EUR is
    # derived as ``total_value_usd / fx_eur_usd``; ``total_value_eur`` stays
    # filled for one release. NULL on rows written before migration 0017.
    total_value_usd: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    fx_eur_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 8), nullable=True)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<PositionSnapshot {self.snapshot_date} = €{self.total_value_eur}>"
