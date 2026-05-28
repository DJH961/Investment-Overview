"""Daily FX rates. Convention: ``base=EUR``; ``rate`` = quote-per-base.

So with ``base=EUR, quote=USD, rate=1.085``, 1 EUR = 1.085 USD.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import CacheBase as Base


class FxHistory(Base):
    __tablename__ = "fx_history"
    __table_args__ = (
        CheckConstraint("length(base) = 3", name="ck_fx_base_len"),
        CheckConstraint("length(quote) = 3", name="ck_fx_quote_len"),
    )

    date: Mapped[date] = mapped_column(Date, primary_key=True)
    base: Mapped[str] = mapped_column(String(3), primary_key=True)
    quote: Mapped[str] = mapped_column(String(3), primary_key=True)
    rate: Mapped[Decimal] = mapped_column(Numeric(12, 8), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="frankfurter")
