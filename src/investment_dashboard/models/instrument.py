"""Instrument model — securities, funds, and synthetic cash positions."""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, CheckConstraint, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from investment_dashboard.models.base import Base

if TYPE_CHECKING:
    from investment_dashboard.models.price_history import PriceHistory
    from investment_dashboard.models.transaction import Transaction


class Instrument(Base):
    __tablename__ = "instruments"
    __table_args__ = (
        CheckConstraint(
            "asset_class IN ('etf','mutual_fund','stock','cash','savings')",
            name="ck_instrument_asset_class",
        ),
        CheckConstraint("length(native_currency) = 3", name="ck_instrument_currency_len"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    name: Mapped[str | None] = mapped_column(String(256))
    asset_class: Mapped[str] = mapped_column(String(16), nullable=False)
    category: Mapped[str | None] = mapped_column(String(64))
    native_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    expense_ratio: Mapped[Decimal | None] = mapped_column(Numeric(7, 5))
    target_weight_pct: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    transactions: Mapped[list[Transaction]] = relationship(back_populates="instrument")
    prices: Mapped[list[PriceHistory]] = relationship(
        back_populates="instrument", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Instrument {self.symbol}>"
