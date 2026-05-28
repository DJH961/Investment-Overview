"""Instrument override — user-tier annotations on a ledger ``Instrument``.

Belongs to the **config** tier. Stores the two fields that are user
choices rather than intrinsic security facts:

* ``category`` — the user-chosen grouping label ("Total US", "Growth",
  "Single Stock") used by the overview treemap and per-instrument lists.
* ``active`` — visibility toggle; deactivated instruments are hidden
  from refreshes and most listings but their transactions stay on the
  ledger.

``instrument_id`` is a loose reference to the ledger-tier ``instruments``
table (integer, indexed). SQLAlchemy ``ForeignKey`` cannot bridge
separate ``MetaData`` instances, and the engine split in Phase 2 puts
each tier on its own SQLite file where DB-level FKs are not enforceable
anyway. The cache-orphan janitor at boot keeps overrides in sync if an
instrument is ever deleted on the ledger.

v2.2 phase (b) adds three *display* overrides that let the user
correct or fill in metadata the importer/enrichment couldn't determine
authoritatively:

* ``name_override`` — pretty name shown in tables/treemap.
* ``asset_class_override`` — classification used for filtering and
  refresh TTLs when the ledger row says ``'unknown'`` (or the user
  disagrees with yfinance's ``quoteType``).
* ``expense_ratio_override`` — manual TER when the issuer does not
  publish one to yfinance.

Effective-value composition (override → ledger → default) is centralised
in :func:`investment_dashboard.services.instrument_enrichment_service.
effective_instrument` so every read path agrees on precedence.
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import Boolean, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import ConfigBase


class InstrumentOverride(ConfigBase):
    __tablename__ = "instrument_overrides"

    # Loose reference to ``instruments.id`` (ledger tier). Validated by
    # the overrides repository on write; a missing instrument is not a
    # constraint violation, just an orphan row to be swept at boot.
    instrument_id: Mapped[int] = mapped_column(primary_key=True)
    category: Mapped[str | None] = mapped_column(String(64))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    name_override: Mapped[str | None] = mapped_column(String(256))
    asset_class_override: Mapped[str | None] = mapped_column(String(16))
    expense_ratio_override: Mapped[Decimal | None] = mapped_column(Numeric(7, 5))

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<InstrumentOverride instrument_id={self.instrument_id} "
            f"category={self.category!r} active={self.active}>"
        )
