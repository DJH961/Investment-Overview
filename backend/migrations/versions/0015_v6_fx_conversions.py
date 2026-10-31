"""v6 fx_conversions: EUR -> USD conversion batches (ledger tier)

Adds the ``fx_conversions`` table backing the FIFO USD pool (plan section 2.5).
Native amounts only; the effective rate is derived. Idempotent: skipped when the
table already exists (e.g. a DB created from the current models).

Revision ID: d2a6b4c8e1f0
Revises: c1f5a3b9e2d4
Create Date: 2026-11-01 09:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d2a6b4c8e1f0"
down_revision: str | Sequence[str] | None = "c1f5a3b9e2d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "fx_conversions" in inspector.get_table_names():
        return
    op.create_table(
        "fx_conversions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("eur_sent", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.Column("usd_received", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.Column("fees_eur", sa.Numeric(precision=18, scale=6), nullable=True),
        sa.Column("note", sa.String(length=512), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.CheckConstraint("eur_sent > 0", name="ck_fx_conversions_eur_pos"),
        sa.CheckConstraint("usd_received > 0", name="ck_fx_conversions_usd_pos"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_fx_conversions_date", "fx_conversions", ["date"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "fx_conversions" not in inspector.get_table_names():
        return
    op.drop_index("ix_fx_conversions_date", table_name="fx_conversions")
    op.drop_table("fx_conversions")
