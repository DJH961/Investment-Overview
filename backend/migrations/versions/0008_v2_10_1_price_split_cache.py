"""v2.10.1 cache stock-split history for split-adjusted historical valuation

Revision ID: d4a9b2e7c5f1
Revises: c3f5a8d1b6e2
Create Date: 2026-05-31 22:20:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4a9b2e7c5f1"
down_revision: str | Sequence[str] | None = "c3f5a8d1b6e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "price_split",
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("ratio", sa.Numeric(precision=18, scale=8), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.PrimaryKeyConstraint("instrument_id", "date"),
    )


def downgrade() -> None:
    op.drop_table("price_split")
