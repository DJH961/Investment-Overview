"""Account model — one row per brokerage/savings/cash account."""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, CheckConstraint, Date, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from investment_dashboard.models.base import LedgerBase as Base

if TYPE_CHECKING:
    from investment_dashboard.models.transaction import Transaction


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        CheckConstraint(
            "broker IN ('vanguard','fidelity','savings_bank')", name="ck_account_broker"
        ),
        CheckConstraint("account_type IN ('brokerage','savings','cash')", name="ck_account_type"),
        CheckConstraint("length(native_currency) = 3", name="ck_account_currency_len"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    broker: Mapped[str] = mapped_column(String(32), nullable=False)
    account_label: Mapped[str] = mapped_column(String(128), nullable=False)
    native_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    account_type: Mapped[str | None] = mapped_column(String(16))
    opened_on: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(String(1024))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")

    transactions: Mapped[list[Transaction]] = relationship(
        back_populates="account", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Account {self.id} {self.broker}:{self.account_label}>"
