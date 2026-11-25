"""v7.4 hicp_index (cache tier)

New ``hicp_index``: the euro-area consumer price index per month (ECB / Eurostat
``HICP.M.U2.N.000000.4D0.INX``), the base of the real euro return. Regenerable
cache data. Idempotent: created only when absent. The downgrade drops the table
(nothing to export).

Revision ID: d7a3f1c9e5b2
Revises: d9b3f1a7c2e5 (0029, frozen legs nullable)
Create Date: 2026-11-25 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d7a3f1c9e5b2"
down_revision: str | Sequence[str] | None = "d9b3f1a7c2e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "hicp_index"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE in set(inspector.get_table_names()):
        return
    op.create_table(
        _TABLE,
        sa.Column("series", sa.String(length=40), nullable=False),
        sa.Column("month", sa.String(length=7), nullable=False),
        sa.Column("value", sa.Numeric(precision=12, scale=4), nullable=False),
        sa.Column("fetched_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("series", "month"),
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE in set(inspector.get_table_names()):
        op.drop_table(_TABLE)
