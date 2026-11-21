"""Daily value of one holding (instrument x account) at a trading day's close.

Cache tier (regenerable), native currency only (currency rule: EUR / USD are
derived at report time, values at the day's rate, flows at their own date's).
One row per ``(date, instrument_id, account_id)`` held at that day's close, plus
any date with a trade or dividend of the holding (a full sale leaves a row with
``quantity`` 0 so its flow is not lost). Built lazily on read by
:mod:`investment_dashboard.services.holding_values_service`, like
``position_snapshots``; dropped from a date on when the ledger, a price, an FX
rate or a split changes.

``value_native`` is ``quantity x split factor x close_price_native``, the same
valuation :func:`positions_service.compute_positions` gives (the stored close is
the feed's split-adjusted close), so per date and currency the rows sum to the
portfolio's native book.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import Date, DateTime, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from investment_dashboard.models.base import CacheBase as Base


class HoldingDailyValue(Base):
    __tablename__ = "holding_daily_values"

    date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    instrument_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False)
    close_price_native: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    value_native: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    net_flow_native: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    dividends_native: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    computed_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.current_timestamp()
    )

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<HoldingDailyValue {self.date} i{self.instrument_id} a{self.account_id} "
            f"{self.value_native} {self.currency}>"
        )
