"""v1.2 snapshots cache, price-cache metadata, account.active

Revision ID: 6b1f8c3e2a91
Revises: 5ac095ef8bb7
Create Date: 2026-05-26 20:45:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "6b1f8c3e2a91"
down_revision: str | Sequence[str] | None = "5ac095ef8bb7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "position_snapshots",
        sa.Column("snapshot_date", sa.Date(), nullable=False),
        sa.Column("total_value_eur", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.Column(
            "computed_at",
            sa.DateTime(),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("snapshot_date"),
    )
    op.create_table(
        "price_cache_metadata",
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("last_refreshed_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("instrument_id"),
    )
    with op.batch_alter_table("accounts", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "active",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("1"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("accounts", schema=None) as batch_op:
        batch_op.drop_column("active")
    op.drop_table("price_cache_metadata")
    op.drop_table("position_snapshots")
