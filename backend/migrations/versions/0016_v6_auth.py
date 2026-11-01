"""v6 auth: password credential, passkeys and server-side sessions

Config-tier tables for the single-owner login (see ``models/auth.py``).
Idempotent: each table is created only when absent and dropped on downgrade
only when present. Under the default single-file layout Alembic migrates the
ledger DB which also carries the config tables.

Revision ID: e3b7c5d9f2a1
Revises: d2a6b4c8e1f0
Create Date: 2026-11-01 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e3b7c5d9f2a1"
down_revision: str | Sequence[str] | None = "d2a6b4c8e1f0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "auth_credential" not in tables:
        op.create_table(
            "auth_credential",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("password_hash", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
    if "auth_passkeys" not in tables:
        op.create_table(
            "auth_passkeys",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("credential_id", sa.LargeBinary(), nullable=False),
            sa.Column("public_key", sa.LargeBinary(), nullable=False),
            sa.Column("sign_count", sa.Integer(), nullable=False),
            sa.Column("transports", sa.Text(), nullable=True),
            sa.Column("name", sa.String(length=80), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("last_used_at", sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("credential_id"),
        )
    if "auth_sessions" not in tables:
        op.create_table(
            "auth_sessions",
            sa.Column("id", sa.String(length=64), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("last_seen_at", sa.DateTime(), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column("user_agent", sa.String(length=256), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )


def downgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    for name in ("auth_sessions", "auth_passkeys", "auth_credential"):
        if name in tables:
            op.drop_table(name)
