"""Intraday prices of single symbols: held stocks/ETFs and the ETF "twins".

Cache tier (regenerable). One row per (symbol, kind, instant): the symbol's
native price at ``captured_at`` (naive UTC). ``kind`` is

* ``holding``: a held, intraday-priced stock/ETF, written next to each portfolio
  sample in ``intraday_value`` (same bars, same instants), so a holding's 1D/1W
  chart is a read (shares x price per instant). Pruned to the rolling 1W window
  like ``intraday_value``.
* ``twin``: an ETF that estimates a mutual fund on the 1D graph. The twin's
  previous session close is stored as a row at that session's close instant, so
  the 1D estimate ``prev_NAV x twin_now / twin_prev_close`` is rebuilt from these
  rows at read time (deterministic, nothing estimated is ever stored). Twins are
  auxiliary symbols, never holdings: they never enter totals, holdings or
  allocations. Intraday rows are pruned to the 1W window, session closes kept
  for the divergence statistics.

Read/write only through the services
(:mod:`investment_dashboard.services.intraday_snapshots_service`,
:mod:`investment_dashboard.services.symbol_prices_service`).
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import CacheBase as Base

#: ``kind`` of a held stock/ETF's price row.
KIND_HOLDING = "holding"
#: ``kind`` of an ETF twin's price row.
KIND_TWIN = "twin"


class IntradaySymbolPrice(Base):
    __tablename__ = "intraday_symbol_prices"

    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    kind: Mapped[str] = mapped_column(
        String(8), primary_key=True, nullable=False, server_default=KIND_TWIN
    )
    captured_at: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    price_native: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<IntradaySymbolPrice {self.symbol} {self.kind} "
            f"{self.captured_at:%Y-%m-%d %H:%M} {self.price_native}>"
        )
