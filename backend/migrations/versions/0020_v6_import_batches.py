"""v6 imports: ``import_batches`` table and ``transactions.import_batch_id``

Ledger tier. Each confirmed broker import gets a batch row; the transactions it
inserted carry the batch id so the import can be listed and undone. Older
transactions keep ``NULL``. Idempotent: the table / column / index are created
only when absent and dropped on downgrade only when present (restores the 0019
schema). v6-only data: ``inv-dashboard-export-v5`` drops it.

Revision ID: c3f8a6d2e9b4
Revises: b7e2c4f9a1d6
Create Date: 2026-11-02 14:30:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3f8a6d2e9b4"
down_revision: str | Sequence[str] | None = "b7e2c4f9a1d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEX = "ix_transactions_import_batch_id"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "import_batches" not in tables:
        op.create_table(
            "import_batches",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("account_id", sa.Integer(), nullable=False),
            sa.Column("broker", sa.String(length=32), nullable=False),
            sa.Column("filename", sa.String(length=256), nullable=False),
            sa.Column("row_count", sa.Integer(), nullable=False),
            sa.Column("duplicate_count", sa.Integer(), nullable=False),
            sa.Column("status", sa.String(length=16), nullable=False),
            sa.Column("actor", sa.String(length=64), nullable=True),
            sa.Column("undone_at", sa.DateTime(), nullable=True),
            sa.Column("undone_by", sa.String(length=64), nullable=True),
            sa.Column("undone_rows", sa.Integer(), nullable=True),
            sa.Column("backup", sa.String(length=128), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_import_batches_created_at", "import_batches", ["created_at"])
    if "transactions" not in tables:
        return
    columns = {c["name"] for c in inspector.get_columns("transactions")}
    if "import_batch_id" not in columns:
        with op.batch_alter_table("transactions", schema=None) as batch_op:
            batch_op.add_column(sa.Column("import_batch_id", sa.Integer(), nullable=True))
    indexes = {i["name"] for i in sa.inspect(op.get_bind()).get_indexes("transactions")}
    if _INDEX not in indexes:
        op.create_index(_INDEX, "transactions", ["import_batch_id"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "transactions" in tables:
        if _INDEX in {i["name"] for i in inspector.get_indexes("transactions")}:
            op.drop_index(_INDEX, table_name="transactions")
        if "import_batch_id" in {c["name"] for c in inspector.get_columns("transactions")}:
            with op.batch_alter_table("transactions", schema=None) as batch_op:
                batch_op.drop_column("import_batch_id")
    if "import_batches" in tables:
        op.drop_index("ix_import_batches_created_at", table_name="import_batches")
        op.drop_table("import_batches")
