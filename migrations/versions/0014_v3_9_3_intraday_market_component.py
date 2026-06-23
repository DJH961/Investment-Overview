"""v3.9.3 intraday samples store the market component, not the total

The Overview "1 Day" graph now stores only the *intraday-priced* (market)
component per sample — the EUR value of stocks/ETFs — and reapplies the constant
cash + NAV base (mutual funds, money-market funds, cash) at render time. This
keeps live-captured and reconstructed points on a single consistent basis, so a
mutual fund's post-close NAV revaluation shifts the whole curve uniformly instead
of spiking the points captured before it (and a part-day-live session joins its
reconstructed remainder without a step).

The storage change is a single column rename on the cache-tier ``intraday_value``
table (``total_value_eur`` → ``market_value_eur``). The table is pure cache
(regenerable, pruned to the current session), so this recreates it rather than
copying rows: stale totals would otherwise be misread as market components for
the rest of the current session.

Idempotent + tier-aware: under the default single-file layout Alembic migrates
the ledger DB which also carries the cache tables; split-DB / packaged installs
(which ship no Alembic) gain the new column via the boot ``create_all`` guard
instead. Skipped when the table already has the new column (e.g. a DB created
from the current model), and a no-op when the table is absent.

Revision ID: c1f5a3b9e2d4
Revises: b8e4f2a0c5d7
Create Date: 2026-06-23 08:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c1f5a3b9e2d4"
down_revision: str | Sequence[str] | None = "b8e4f2a0c5d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _columns(inspector: sa.Inspector, table: str) -> set[str]:
    return {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "intraday_value" not in tables:
        return
    columns = _columns(inspector, "intraday_value")
    if "market_value_eur" in columns:
        return  # already on the new schema
    # Pure cache table: recreate with the renamed column rather than copy stale
    # totals (which would be misread as market components until pruned).
    op.drop_table("intraday_value")
    op.create_table(
        "intraday_value",
        sa.Column("captured_at", sa.DateTime(), nullable=False),
        sa.Column("market_value_eur", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.PrimaryKeyConstraint("captured_at"),
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "intraday_value" not in tables:
        return
    columns = _columns(inspector, "intraday_value")
    if "total_value_eur" in columns:
        return
    op.drop_table("intraday_value")
    op.create_table(
        "intraday_value",
        sa.Column("captured_at", sa.DateTime(), nullable=False),
        sa.Column("total_value_eur", sa.Numeric(precision=18, scale=6), nullable=False),
        sa.PrimaryKeyConstraint("captured_at"),
    )
