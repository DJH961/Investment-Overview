"""Daily closing prices per instrument, in the instrument's native currency."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import Date, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from investment_dashboard.models.base import Base

if TYPE_CHECKING:
    from investment_dashboard.models.instrument import Instrument


class PriceHistory(Base):
    __tablename__ = "price_history"

    instrument_id: Mapped[int] = mapped_column(
        ForeignKey("instruments.id", ondelete="CASCADE"), primary_key=True
    )
    date: Mapped[date] = mapped_column(Date, primary_key=True)
    close_native: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="yfinance")

    instrument: Mapped[Instrument] = relationship(back_populates="prices")
