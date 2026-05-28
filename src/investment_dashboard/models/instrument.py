"""Instrument model — securities, funds, and synthetic cash positions.

Belongs to the **ledger** tier. Holds intrinsic identity facts the
issuer publishes and the user does not choose:

* ``symbol`` / ``name`` — identity.
* ``asset_class`` — taxonomy (etf / mutual_fund / stock / cash /
  savings).
* ``native_currency`` — currency of the security's quote.
* ``expense_ratio`` — the fund's Total Expense Ratio. Set by the
  issuer (e.g. Vanguard publishes VTI's TER); the user does not pick
  it. The Settings UI editor exists today as a *manual enrichment*
  workaround because we don't yet ingest TERs from a market-data
  source; it is not a preference override and stays on the ledger.

The user-tier annotations ``category`` and ``active`` live in a
separate config-tier table, :class:`InstrumentOverride`. The unused
``target_weight_pct`` column was removed in v2.0 — every active read
path uses ``target_allocations`` / ``target_allocation_items`` instead.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from investment_dashboard.models.base import LedgerBase as Base

if TYPE_CHECKING:
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
    native_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    expense_ratio: Mapped[Decimal | None] = mapped_column(Numeric(7, 5))

    transactions: Mapped[list[Transaction]] = relationship(back_populates="instrument")
    # NOTE: the ``prices`` relationship to :class:`PriceHistory` previously
    # lived here. ``PriceHistory`` now lives in the cache tier (separate
    # ``MetaData``), so a SQLAlchemy ``relationship()`` can no longer
    # bridge it. Look up prices via ``prices_repo`` instead.
    #
    # The user-tier ``category`` and ``active`` columns are no longer on
    # this table; see :class:`InstrumentOverride` for their replacement.

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Instrument {self.symbol}>"
