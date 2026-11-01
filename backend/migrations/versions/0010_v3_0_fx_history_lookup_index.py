"""v3.0 add fx_history (base, quote, date) lookup index

The ``fx_history`` PK is ``(date, base, quote)`` with ``date`` leading, but
every lookup filters ``WHERE base=? AND quote=?`` then orders by ``date``
(see ``repositories/fx_repo``). With ``date`` as the leading PK column those
filters cannot use the PK efficiently, so add an index matching the real
query shape.

Idempotent + tier-aware: under a split-DB layout Alembic only runs against the
ledger tier, which does not hold ``fx_history`` (it lives in the cache tier and
is materialised by ``create_all``), so the index is created only when the table
is actually present in the migrated database. ``CREATE INDEX IF NOT EXISTS``
also makes it a no-op when ``create_all`` already built the index from the
current model.

Revision ID: f6c2d0a4b8e3
Revises: e5b1c9a3f7d2
Create Date: 2026-06-21 13:40:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f6c2d0a4b8e3"
down_revision: str | Sequence[str] | None = "e5b1c9a3f7d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEX_NAME = "ix_fx_history_base_quote_date"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "fx_history" not in set(inspector.get_table_names()):
        return
    op.execute(
        sa.text(f"CREATE INDEX IF NOT EXISTS {_INDEX_NAME} ON fx_history (base, quote, date)")
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "fx_history" not in set(inspector.get_table_names()):
        return
    op.execute(sa.text(f"DROP INDEX IF EXISTS {_INDEX_NAME}"))
