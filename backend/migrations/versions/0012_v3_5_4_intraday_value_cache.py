"""v3.5.4 intraday value cache for the Overview "1 Day" graph

Adds the cache-tier ``intraday_value`` table holding within-day portfolio-value
samples (one row per captured instant, EUR), so the Overview "1 Day" range draws
a real intraday curve instead of a one/two-point stub. Live samples are appended
on each market-hours price refresh; the most recent session is also
reconstructed at ~30-minute granularity from the price feed. Pure cache tier
(regenerable), pruned to the current session.

Idempotent + tier-aware: under the default single-file layout Alembic migrates
the ledger DB which also carries the cache tables, so the table is created
there. Split-DB / packaged installs (which ship no Alembic) gain it via the boot
``create_all`` guard instead. Creating the table is skipped when it already
exists (e.g. a DB created from the current model).

Revision ID: b8e4f2a1d7c9
Revises: a7d3e1f9c4b6
Create Date: 2026-06-22 16:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8e4f2a1d7c9"
down_revision: str | Sequence[str] | None = "a7d3e1f9c4b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "intraday_value" in set(inspector.get_table_names()):
        return
    op.create_table(
        "intraday_value",
        sa.Column("captured_at", sa.DateTime(), nullable=False),
        sa.Column("total_value_eur", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.PrimaryKeyConstraint("captured_at"),
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "intraday_value" in set(inspector.get_table_names()):
        op.drop_table("intraday_value")
