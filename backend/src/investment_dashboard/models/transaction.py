"""Transaction model — the unified ledger.

Every position change, dividend, and cash movement is one row here. See spec
§4.1 for the kind enum and sign conventions.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from investment_dashboard.models.base import LedgerBase as Base

if TYPE_CHECKING:
    from investment_dashboard.models.account import Account
    from investment_dashboard.models.instrument import Instrument


class TransactionKind(StrEnum):
    """Enumerated kinds — see spec §4.1."""

    BUY = "buy"
    SELL = "sell"
    DIVIDEND_CASH = "dividend_cash"
    DIVIDEND_REINVEST = "dividend_reinvest"
    DEPOSIT = "deposit"
    WITHDRAWAL = "withdrawal"
    INTEREST = "interest"
    FEE = "fee"
    # ``transfer_in`` / ``transfer_out`` are external-cash-flow kinds for moving
    # money between accounts (or in/out of the portfolio) without a buy/sell.
    # They are offered in the manual-add form (``_kinds()``) and counted as a
    # contribution / withdrawal everywhere external flows matter (metrics_service,
    # benchmark_service, _deposits_query, _period_query). CSV importers don't emit
    # them directly — broker "transfer in/out" rows normalise to deposit/withdrawal
    # in the per-broker action maps — but the kinds are first-class for manual use.
    TRANSFER_IN = "transfer_in"
    TRANSFER_OUT = "transfer_out"
    SPLIT = "split"


class TransactionSource(StrEnum):
    IMPORT_VANGUARD_CSV = "import_vanguard_csv"
    IMPORT_VANGUARD_XLSX = "import_vanguard_xlsx"
    IMPORT_FIDELITY_CSV = "import_fidelity_csv"
    MANUAL = "manual"
    MIGRATION = "migration"


_KIND_VALUES = ",".join(f"'{k.value}'" for k in TransactionKind)
_SOURCE_VALUES = ",".join(f"'{s.value}'" for s in TransactionSource)


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        UniqueConstraint(
            "account_id",
            "external_id",
            name="uq_transactions_account_external",
        ),
        CheckConstraint(f"kind IN ({_KIND_VALUES})", name="ck_transactions_kind"),
        CheckConstraint(f"source IN ({_SOURCE_VALUES})", name="ck_transactions_source"),
        Index("ix_transactions_date", "date"),
        Index("ix_transactions_instrument_id", "instrument_id"),
        Index("ix_transactions_account_date", "account_id", "date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)

    account_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    settlement_date: Mapped[date | None] = mapped_column(Date)

    kind: Mapped[str] = mapped_column(String(32), nullable=False)

    instrument_id: Mapped[int | None] = mapped_column(
        ForeignKey("instruments.id", ondelete="RESTRICT")
    )

    quantity: Mapped[Decimal | None] = mapped_column(Numeric(18, 8))
    price_native: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    gross_native: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    fees_native: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    net_native: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))

    fx_rate_to_eur: Mapped[Decimal | None] = mapped_column(Numeric(12, 8))
    net_eur: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    #: Frozen USD leg of the cash movement, valued at the **trade-date**
    #: EUR→USD rate. For USD-native accounts this is exactly ``net_native``
    #: (USD is the booked currency — see spec §4.1 and the v2.9 "freeze the
    #: native leg" change); for every other currency it is derived once at
    #: write time and never recomputed. Read paths prefer this column and
    #: only fall back to live FX derivation when it is ``NULL`` (a row that
    #: predates the backfill or was written while FX history had a gap).
    net_usd: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))

    description: Mapped[str | None] = mapped_column(String(512))
    external_id: Mapped[str | None] = mapped_column(String(128))
    source: Mapped[str] = mapped_column(String(32), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        server_default=func.current_timestamp(),
        nullable=False,
    )

    account: Mapped[Account] = relationship(back_populates="transactions")
    instrument: Mapped[Instrument | None] = relationship(back_populates="transactions")

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<Transaction {self.id} {self.date} {self.kind} "
            f"acct={self.account_id} inst={self.instrument_id}>"
        )
