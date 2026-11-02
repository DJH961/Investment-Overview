"""v6 settings: change history table ``app_config_audit``

Config-tier table written by ``settings_service`` (one row per changed key;
secret values stored as ``<redacted>``). Idempotent: created only when absent,
dropped on downgrade only when present (restores the 0017 schema). v6-only data:
``inv-dashboard-export-v5`` drops it.

Revision ID: a5d9e7f1b4c3
Revises: f4c8d6e0a3b2
Create Date: 2026-11-02 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a5d9e7f1b4c3"
down_revision: str | Sequence[str] | None = "f4c8d6e0a3b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if "app_config_audit" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "app_config_audit",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("old_value", sa.Text(), nullable=True),
        sa.Column("new_value", sa.Text(), nullable=True),
        sa.Column("changed_at", sa.DateTime(), nullable=False),
        sa.Column("actor", sa.String(length=64), nullable=False),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_app_config_audit_key", "app_config_audit", ["key"])


def downgrade() -> None:
    if "app_config_audit" not in sa.inspect(op.get_bind()).get_table_names():
        return
    op.drop_index("ix_app_config_audit_key", table_name="app_config_audit")
    op.drop_table("app_config_audit")
