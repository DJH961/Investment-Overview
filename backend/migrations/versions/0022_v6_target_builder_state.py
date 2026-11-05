"""v6 targets: save the allocation calculator's builder state

Adds one nullable config-tier column to ``target_allocations``:

* ``builder_state`` — JSON text of the calculator mix the target was saved
  from: the mode (by fund / by category), each category's typed weight, split
  rule and which funds get new money (deselected funds included by omission),
  and "Invest only in ETFs". ``NULL`` = an older target (fund weights only).

Idempotent: added only when absent and dropped on downgrade only when present
(restores the 0021 schema). v6-only data: ``inv-dashboard-export-v5`` drops it.

Revision ID: f1c6b8a2d4e7
Revises: e5a91b7c3d28
Create Date: 2026-11-05 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1c6b8a2d4e7"
down_revision: str | Sequence[str] | None = "e5a91b7c3d28"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "target_allocations"
_COLUMN = "builder_state"


def _existing() -> set[str] | None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in inspector.get_table_names():
        return None
    return {c["name"] for c in inspector.get_columns(_TABLE)}


def upgrade() -> None:
    have = _existing()
    if have is None or _COLUMN in have:
        return
    with op.batch_alter_table(_TABLE, schema=None) as batch_op:
        batch_op.add_column(sa.Column(_COLUMN, sa.Text(), nullable=True))


def downgrade() -> None:
    have = _existing()
    if have is None or _COLUMN not in have:
        return
    with op.batch_alter_table(_TABLE, schema=None) as batch_op:
        batch_op.drop_column(_COLUMN)
