"""Native-USD snapshot columns (currency storage switch)

Adds ``position_snapshots.total_value_usd`` / ``fx_eur_usd`` and
``intraday_value.market_value_usd``. EUR is then derived as ``usd / fx`` at that
instant. The old EUR columns stay filled for one release. Cache-tier tables:
each column is added only when its table exists and the column is absent, and
dropped on downgrade only when present (restores the 0016 schema).

Revision ID: f4c8d6e0a3b2
Revises: e3b7c5d9f2a1
Create Date: 2026-11-01 15:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f4c8d6e0a3b2"
down_revision: str | Sequence[str] | None = "e3b7c5d9f2a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS: tuple[tuple[str, str, int, int], ...] = (
    ("position_snapshots", "total_value_usd", 18, 6),
    ("position_snapshots", "fx_eur_usd", 12, 8),
    ("intraday_value", "market_value_usd", 18, 6),
)


def _existing(table: str) -> set[str] | None:
    insp = sa.inspect(op.get_bind())
    if table not in insp.get_table_names():
        return None
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    for table, column, prec, scale in _COLUMNS:
        cols = _existing(table)
        if cols is not None and column not in cols:
            op.add_column(table, sa.Column(column, sa.Numeric(prec, scale), nullable=True))


def downgrade() -> None:
    for table, column, _prec, _scale in _COLUMNS:
        cols = _existing(table)
        if cols is not None and column in cols:
            with op.batch_alter_table(table) as batch:
                batch.drop_column(column)
