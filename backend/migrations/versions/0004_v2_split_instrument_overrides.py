"""v2.0 split instrument_overrides off the ledger

Phase 1b of the v2.0 rework. Two columns on ``instruments`` were user
choices rather than intrinsic security facts and now live in a new
config-tier table:

* ``category`` — user-chosen grouping label.
* ``active`` — visibility toggle.

A third column, ``target_weight_pct``, was dead code (every read path
uses ``target_allocations`` / ``target_allocation_items`` instead) and
is dropped here. ``expense_ratio`` stays on ``instruments`` — it is
published by the issuer, not chosen by the user.

The upgrade copies existing values into ``instrument_overrides`` and
then drops the three columns from ``instruments`` via batch ALTER
(SQLite cannot drop a column in place pre-3.35; ``render_as_batch`` is
already enabled in ``env.py``).

Revision ID: 8d3a2e5b14c6
Revises: 7c2f1d4a93b5
Create Date: 2026-05-28 07:35:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8d3a2e5b14c6"
down_revision: str | Sequence[str] | None = "7c2f1d4a93b5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "instrument_overrides",
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=True),
        sa.Column(
            "active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.PrimaryKeyConstraint("instrument_id"),
    )

    # Copy existing per-instrument category/active into the new table.
    # Only seed rows whose values diverge from the documented defaults
    # (``category=NULL``, ``active=True``) so the override table stays
    # sparse — that's the whole point of "override".
    op.execute(
        sa.text(
            """
            INSERT INTO instrument_overrides (instrument_id, category, active)
            SELECT id, category, active
            FROM instruments
            WHERE category IS NOT NULL OR active = 0
            """
        )
    )

    # Drop the three columns we just relocated / retired. Batch mode
    # rebuilds the ``instruments`` table, preserving the unique index
    # on ``symbol`` and the existing CHECK constraints.
    with op.batch_alter_table("instruments", schema=None) as batch_op:
        batch_op.drop_column("category")
        batch_op.drop_column("active")
        batch_op.drop_column("target_weight_pct")


def downgrade() -> None:
    with op.batch_alter_table("instruments", schema=None) as batch_op:
        batch_op.add_column(sa.Column("category", sa.String(length=64), nullable=True))
        batch_op.add_column(
            sa.Column(
                "active",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("1"),
            )
        )
        batch_op.add_column(
            sa.Column("target_weight_pct", sa.Numeric(precision=5, scale=2), nullable=True)
        )

    # Push the override values back onto the ledger row.
    op.execute(
        sa.text(
            """
            UPDATE instruments
            SET category = (
                    SELECT category FROM instrument_overrides
                    WHERE instrument_overrides.instrument_id = instruments.id
                ),
                active = COALESCE(
                    (SELECT active FROM instrument_overrides
                     WHERE instrument_overrides.instrument_id = instruments.id),
                    1
                )
            """
        )
    )

    op.drop_table("instrument_overrides")
