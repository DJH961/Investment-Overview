"""v2.9 freeze the USD transaction leg (``transactions.net_usd``)

Adds a ``net_usd`` column to ``transactions`` so every cash movement carries
both currency legs, frozen at the **trade-date** EUR→USD rate, rather than the
USD side being re-derived on every page render. USD is the booked currency for
most rows, so this makes the common case exact and persisted (EUR is derived).

Backfill (best-effort, single-file layout where ``fx_history`` lives in the
same database):

1.  **USD-native accounts** — ``net_usd = net_native`` verbatim. USD is the
    booked currency; no FX is involved.
2.  **Everything else** — ``net_usd = net_eur × rate`` where ``rate`` is the
    EUR→USD rate on (or forward-filled to) the transaction's date.

Rows that can't be priced (no ``net_eur`` / no FX history on or before the
trade date — e.g. split-DB layouts where this migration only sees the ledger
tier) are left ``NULL`` and repaired later by the boot / *Settings →
Recalculate* backfill once accurate FX data is present.

Revision ID: a1c7f2d9e3b8
Revises: 9e4b3f6c2a17
Create Date: 2026-05-31 10:55:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1c7f2d9e3b8"
down_revision: str | Sequence[str] | None = "9e4b3f6c2a17"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # Idempotent add: a packaged/dev boot may have created ``transactions`` via
    # ``create_all`` (current model already carries ``net_usd``) or added the
    # column through the boot ``_ensure_added_columns`` guard while the Alembic
    # version stayed at 0005. In that case the column already exists and a plain
    # ``ADD COLUMN`` would raise ``duplicate column name: net_usd``. Only add it
    # when it is genuinely missing; the backfill below still runs either way.
    existing_columns = {col["name"] for col in inspector.get_columns("transactions")}
    if "net_usd" not in existing_columns:
        with op.batch_alter_table("transactions", schema=None) as batch_op:
            batch_op.add_column(
                sa.Column("net_usd", sa.Numeric(precision=18, scale=6), nullable=True)
            )

    tables = set(inspector.get_table_names())

    # 1. USD-native accounts: the booked amount IS the USD leg.
    if "accounts" in tables:
        op.execute(
            sa.text(
                "UPDATE transactions SET net_usd = net_native "
                "WHERE net_native IS NOT NULL AND account_id IN ("
                "    SELECT id FROM accounts WHERE upper(native_currency) = 'USD'"
                ")"
            )
        )

    # 2. Everything else: derive USD from the stored EUR leg at the trade-date
    #    rate (forward-filled to the most recent prior business day). Only runs
    #    when ``fx_history`` is reachable in this database (the default
    #    single-file layout); under a split-DB ledger-only migration it isn't,
    #    so those rows stay NULL for the boot / Settings backfill to repair.
    if "fx_history" in tables:
        op.execute(
            sa.text(
                "UPDATE transactions SET net_usd = net_eur * ("
                "    SELECT f.rate FROM fx_history f "
                "    WHERE f.base = 'EUR' AND f.quote = 'USD' AND f.date <= transactions.date "
                "    ORDER BY f.date DESC LIMIT 1"
                ") "
                "WHERE net_usd IS NULL AND net_eur IS NOT NULL AND EXISTS ("
                "    SELECT 1 FROM fx_history f "
                "    WHERE f.base = 'EUR' AND f.quote = 'USD' AND f.date <= transactions.date"
                ")"
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("transactions", schema=None) as batch_op:
        batch_op.drop_column("net_usd")
