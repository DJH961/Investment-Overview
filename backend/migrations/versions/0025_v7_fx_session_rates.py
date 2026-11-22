"""v7.2 fx_session_rates (ledger tier)

New ``fx_session_rates``: the EUR/USD rate at each US session's open and close,
recorded from the intraday samples before they are pruned (raw market data that
cannot be fetched again, so it lives in the ledger tier, which a cache reset does
not wipe). Idempotent: created only when absent. The downgrade drops the table
(v7.2-only data: nothing to export).

Revision ID: b8d4f0e2c625
Revises: a7c3e9d1b524
Create Date: 2026-11-21 18:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8d4f0e2c625"
down_revision: str | Sequence[str] | None = "a7c3e9d1b524"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "fx_session_rates"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE in set(inspector.get_table_names()):
        return
    op.create_table(
        _TABLE,
        sa.Column("session_date", sa.Date(), nullable=False),
        sa.Column("open_rate", sa.Numeric(precision=12, scale=8), nullable=False),
        sa.Column("close_rate", sa.Numeric(precision=12, scale=8), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("open_at", sa.DateTime(), nullable=True),
        sa.Column("close_at", sa.DateTime(), nullable=True),
        sa.Column(
            "recorded_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("session_date"),
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if _TABLE in set(inspector.get_table_names()):
        op.drop_table(_TABLE)
