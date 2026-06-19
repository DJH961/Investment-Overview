"""v3.0 rebrand the EUR savings account to a brand-free code

Older databases tag the EUR savings account with a legacy broker code and the
synthetic Tagesgeld cash line with a legacy instrument symbol. Both are renamed
here so an existing on-disk ledger keeps working against the brand-free seed in
:mod:`investment_dashboard.services.onboarding_service`:

* ``accounts.broker``  legacy savings code -> ``'savings_bank'``
* ``instruments.symbol``  legacy cash symbol -> ``'SAVINGS_CASH'``

Legacy rows are targeted **structurally** (by what they are, not by the old
literal): the broker that is neither Vanguard nor Fidelity, and the synthetic
``cash``/``savings`` asset. No legacy identifier is hard-coded.

The ``ck_account_broker`` CHECK constraint enumerates the allowed broker codes,
so the rename cannot be a plain ``UPDATE`` on an existing DB — SQLite would
reject the new value. The constraint is therefore dropped, the data relabelled,
and the constraint re-added with the new code via ``batch_alter_table`` (SQLite
rebuilds the table; ``render_as_batch`` is already enabled in ``env.py``).

Revision ID: e5b1c9a3f7d2
Revises: d4a9b2e7c5f1
Create Date: 2026-06-19 14:05:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "e5b1c9a3f7d2"
down_revision: str | Sequence[str] | None = "d4a9b2e7c5f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_NEW_BROKER_CHECK = "broker IN ('vanguard', 'fidelity', 'savings_bank')"


def upgrade() -> None:
    # 1. Drop the broker enum check so the legacy code can be relabelled
    #    (SQLite enforces CHECK on UPDATE, and the old code is not in the new set).
    with op.batch_alter_table("accounts", schema=None) as batch_op:
        batch_op.drop_constraint("ck_account_broker", type_="check")

    # 2. Relabel the legacy savings broker code. Targeted structurally so the
    #    old literal never appears here: any broker that is not one of the two
    #    brokerages is the savings account.
    op.execute(
        "UPDATE accounts SET broker = 'savings_bank' "
        "WHERE broker NOT IN ('vanguard', 'fidelity', 'savings_bank')"
    )

    # 3. Relabel the synthetic savings/cash instrument symbol, again by what it
    #    is (a cash/savings asset) rather than by the old symbol literal.
    op.execute(
        "UPDATE instruments SET symbol = 'SAVINGS_CASH' "
        "WHERE asset_class IN ('cash', 'savings') AND symbol <> 'SAVINGS_CASH'"
    )

    # 4. Re-add the broker enum check with the new code.
    with op.batch_alter_table("accounts", schema=None) as batch_op:
        batch_op.create_check_constraint("ck_account_broker", _NEW_BROKER_CHECK)


def downgrade() -> None:
    # The legacy broker/symbol codes are intentionally not restored — they were
    # vendor names removed for the public-repo migration. The relabelled data is
    # already valid under the constraint, so the broker check is simply
    # re-asserted to keep upgrade/downgrade schema-symmetric.
    with op.batch_alter_table("accounts", schema=None) as batch_op:
        batch_op.drop_constraint("ck_account_broker", type_="check")
        batch_op.create_check_constraint("ck_account_broker", _NEW_BROKER_CHECK)
