"""Import batch (ledger tier, migration ``0020``).

One row per confirmed broker import. Every transaction the import inserted
carries its ``import_batch_id``, so the batch can be listed and undone as a
whole. A manual edit of an imported row detaches it from its batch (an undo
keeps the user's edit). Batches are never deleted: an undo sets ``status`` to
``undone``. Imports made before this table existed have no batch.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import LedgerBase as Base

BATCH_ACTIVE = "active"
BATCH_UNDONE = "undone"


class ImportBatch(Base):
    __tablename__ = "import_batches"
    __table_args__ = (Index("ix_import_batches_created_at", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    #: Loose reference to ``accounts.id`` (kept when the account goes away).
    account_id: Mapped[int] = mapped_column(Integer, nullable=False)
    broker: Mapped[str] = mapped_column(String(32), nullable=False)
    filename: Mapped[str] = mapped_column(String(256), nullable=False)
    #: Transactions inserted by the import (duplicates are not counted).
    row_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    duplicate_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: ``active`` or ``undone``.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=BATCH_ACTIVE)
    actor: Mapped[str | None] = mapped_column(String(64))
    undone_at: Mapped[datetime | None] = mapped_column(DateTime)
    undone_by: Mapped[str | None] = mapped_column(String(64))
    undone_rows: Mapped[int | None] = mapped_column(Integer)
    backup: Mapped[str | None] = mapped_column(String(128))

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ImportBatch {self.id} {self.broker} {self.filename!r} {self.status}>"
