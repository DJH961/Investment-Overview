"""Account repository — CRUD against the ``accounts`` table."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.models import Account


def list_accounts(session: Session) -> Sequence[Account]:
    """Return all accounts ordered by broker then label."""
    stmt = select(Account).order_by(Account.broker, Account.account_label)
    return session.scalars(stmt).all()


def get_account(session: Session, account_id: int) -> Account | None:
    return session.get(Account, account_id)


def create_account(
    session: Session,
    *,
    broker: str,
    account_label: str,
    native_currency: str,
    account_type: str | None = None,
) -> Account:
    """Insert a new account. Caller is responsible for ``session.commit``."""
    account = Account(
        broker=broker,
        account_label=account_label,
        native_currency=native_currency.upper(),
        account_type=account_type,
    )
    session.add(account)
    session.flush()
    return account


def find_by_broker(session: Session, broker: str) -> Sequence[Account]:
    """All accounts for a given broker, ordered by label."""
    stmt = select(Account).where(Account.broker == broker).order_by(Account.account_label)
    return session.scalars(stmt).all()


def update_account(
    session: Session,
    account_id: int,
    *,
    account_label: str | None = None,
    account_type: str | None = None,
) -> Account:
    """Update mutable fields on an account. Raises ``ValueError`` if not found.

    ``broker`` and ``native_currency`` are intentionally **not** mutable —
    they are referenced by ledger rows and changing them would corrupt
    historical data.
    """
    account = session.get(Account, account_id)
    if account is None:
        raise ValueError(f"Account {account_id} not found")
    if account_label is not None:
        account.account_label = account_label
    if account_type is not None:
        account.account_type = account_type
    session.flush()
    return account
