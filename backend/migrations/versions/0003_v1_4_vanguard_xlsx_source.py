"""v1.4 add import_vanguard_xlsx source

Allow ``transactions.source = 'import_vanguard_xlsx'`` so the new
Vanguard Full-History XLSX importer can record its provenance without
falling back to the CSV label (see CHANGELOG v1.4.0).

Revision ID: 7c2f1d4a93b5
Revises: 6b1f8c3e2a91
Create Date: 2026-05-27 20:50:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "7c2f1d4a93b5"
down_revision: str | Sequence[str] | None = "6b1f8c3e2a91"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_NEW_SOURCES = (
    "import_vanguard_csv",
    "import_vanguard_xlsx",
    "import_fidelity_csv",
    "manual",
    "migration",
)

_OLD_SOURCES = (
    "import_vanguard_csv",
    "import_fidelity_csv",
    "manual",
    "migration",
)


def _values_clause(values: tuple[str, ...]) -> str:
    return ",".join(f"'{v}'" for v in values)


def upgrade() -> None:
    # SQLite can't ALTER a CHECK constraint in place — use batch mode to
    # rebuild the table with the wider allow-list. Existing rows are
    # unaffected; the new value is simply now permitted.
    with op.batch_alter_table("transactions", schema=None) as batch_op:
        batch_op.drop_constraint("ck_transactions_source", type_="check")
        batch_op.create_check_constraint(
            "ck_transactions_source",
            f"source IN ({_values_clause(_NEW_SOURCES)})",
        )


def downgrade() -> None:
    with op.batch_alter_table("transactions", schema=None) as batch_op:
        batch_op.drop_constraint("ck_transactions_source", type_="check")
        batch_op.create_check_constraint(
            "ck_transactions_source",
            f"source IN ({_values_clause(_OLD_SOURCES)})",
        )
