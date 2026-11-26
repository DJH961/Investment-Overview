"""Monthly euro-area HICP index values (cache tier, 7.4 P10).

One row per ``(series, month)``: the consumer price index the real euro return is
measured against (:mod:`investment_dashboard.adapters.ecb_hicp`). Regenerable from
the ECB at any time, so it lives in the cache tier: a cache reset wipes it and the
next end-of-day job fetches it again. Migration ``0030``. Read and write only
through :mod:`investment_dashboard.services.hicp_service`.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import CacheBase as Base


class HicpIndex(Base):
    __tablename__ = "hicp_index"

    #: The provider's series key (``HICP.M.U2.N.000000.4D0.INX``).
    series: Mapped[str] = mapped_column(String(40), primary_key=True)
    #: ``YYYY-MM``.
    month: Mapped[str] = mapped_column(String(7), primary_key=True)
    value: Mapped[Decimal] = mapped_column(Numeric(12, 4), nullable=False)
    #: When this row was last confirmed by a fetch (naive UTC).
    fetched_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<HicpIndex {self.series} {self.month}={self.value}>"
