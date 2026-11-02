"""v6 instruments: provider-symbol mapping and pricing mode

Adds two nullable config-tier columns to ``instrument_overrides``:

* ``provider_symbol`` — ticker the price provider uses when it differs from the
  broker symbol (``NULL`` = the ledger symbol).
* ``pricing_mode`` — ``auto`` / ``manual`` / ``delisted`` (``NULL`` = auto).

Idempotent: a column is added only when absent and dropped on downgrade only
when present (restores the 0018 schema). v6-only data: ``inv-dashboard-export-v5``
drops it.

Revision ID: b7e2c4f9a1d6
Revises: a5d9e7f1b4c3
Create Date: 2026-11-02 14:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7e2c4f9a1d6"
down_revision: str | Sequence[str] | None = "a5d9e7f1b4c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "instrument_overrides"
_COLUMNS: tuple[tuple[str, int], ...] = (("provider_symbol", 32), ("pricing_mode", 16))


def _existing() -> set[str] | None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE not in inspector.get_table_names():
        return None
    return {c["name"] for c in inspector.get_columns(_TABLE)}


def upgrade() -> None:
    have = _existing()
    if have is None:
        return
    missing = [(name, size) for name, size in _COLUMNS if name not in have]
    if not missing:
        return
    with op.batch_alter_table(_TABLE, schema=None) as batch_op:
        for name, size in missing:
            batch_op.add_column(sa.Column(name, sa.String(length=size), nullable=True))


def downgrade() -> None:
    have = _existing()
    if have is None:
        return
    present = [name for name, _size in _COLUMNS if name in have]
    if not present:
        return
    with op.batch_alter_table(_TABLE, schema=None) as batch_op:
        for name in reversed(present):
            batch_op.drop_column(name)
