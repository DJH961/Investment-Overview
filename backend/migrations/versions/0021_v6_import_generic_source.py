"""v6 add import_generic source

Allow ``transactions.source = 'import_generic'`` for the flexible importer.

v6-only data: ``inv-dashboard-export-v5`` relabels such rows to ``manual``
(the downgrade below does the same before narrowing the allow-list).

Revision ID: e5a91b7c3d28
Revises: c3f8a6d2e9b4
Create Date: 2026-11-03 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "e5a91b7c3d28"
down_revision: str | Sequence[str] | None = "c3f8a6d2e9b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_OLD_SOURCES = (
    "import_vanguard_csv",
    "import_vanguard_xlsx",
    "import_fidelity_csv",
    "manual",
    "migration",
)

_NEW_SOURCES = (
    "import_vanguard_csv",
    "import_vanguard_xlsx",
    "import_fidelity_csv",
    "import_generic",
    "manual",
    "migration",
)


def _values_clause(values: tuple[str, ...]) -> str:
    return ",".join(f"'{v}'" for v in values)


def upgrade() -> None:
    with op.batch_alter_table("transactions", schema=None) as batch_op:
        batch_op.drop_constraint("ck_transactions_source", type_="check")
        batch_op.create_check_constraint(
            "ck_transactions_source",
            f"source IN ({_values_clause(_NEW_SOURCES)})",
        )


def downgrade() -> None:
    op.execute("UPDATE transactions SET source = 'manual' WHERE source = 'import_generic'")
    with op.batch_alter_table("transactions", schema=None) as batch_op:
        batch_op.drop_constraint("ck_transactions_source", type_="check")
        batch_op.create_check_constraint(
            "ck_transactions_source",
            f"source IN ({_values_clause(_OLD_SOURCES)})",
        )
