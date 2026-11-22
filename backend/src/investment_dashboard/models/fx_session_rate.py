"""EUR/USD at each US session's open and close (ledger tier, v7.2).

One row per trading session: the rate (USD per 1 EUR) struck beside the first
intraday sample at the 09:30 ET open and the last one at the close, taken from the
stored intraday samples before they are pruned. Raw market observations, not a
derived-currency column: the Currency page splits each day's currency effect into
inside / outside market hours with them.

**Why the ledger tier.** The intraday samples are pruned after about a week and
past session rates cannot be fetched again cheaply, so these rows cannot be
rebuilt. The cache tier is wiped by Settings > Reset (cache level) and is not
backed up; the ledger tier survives a cache (and transactions) reset and is in
the sealed backups, like ``fx_conversions``. Migration ``b8d4f0e2c625`` (0025). Read and write only through
:mod:`investment_dashboard.services.fx_session_rates_service`.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import LedgerBase as Base


class FxSessionRate(Base):
    __tablename__ = "fx_session_rates"

    session_date: Mapped[date] = mapped_column(Date, primary_key=True)
    #: USD per 1 EUR at the session open (first sample at or after 09:30 ET).
    open_rate: Mapped[Decimal] = mapped_column(Numeric(12, 8), nullable=False)
    #: USD per 1 EUR at the session close (last sample at or before the close).
    close_rate: Mapped[Decimal] = mapped_column(Numeric(12, 8), nullable=False)
    #: Where the two rates came from (``samples``: the stored intraday samples).
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    #: The sample instants the rates were read at (naive UTC).
    open_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    close_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False), server_default=func.current_timestamp(), nullable=False
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<FxSessionRate {self.session_date} {self.open_rate} -> {self.close_rate}>"
