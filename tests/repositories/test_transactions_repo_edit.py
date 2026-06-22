"""Tests for transactions_repo update/delete (manual transaction editing)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import accounts_repo, transactions_repo


def _account(session: Session) -> int:
    return accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Manual",
        native_currency="USD",
        account_type="brokerage",
    ).id


def _insert(session: Session, account_id: int) -> Transaction:
    txn = Transaction(
        account_id=account_id,
        date=date(2024, 1, 5),
        kind="deposit",
        net_native=Decimal("100"),
        source=TransactionSource.MANUAL,
    )
    inserted = transactions_repo.insert_transaction(session, txn)
    assert inserted is not None
    return inserted


def test_update_transaction_changes_fields(session: Session) -> None:
    account_id = _account(session)
    txn = _insert(session, account_id)
    updated = transactions_repo.update_transaction(
        session, txn.id, net_native=Decimal("250"), description="edited"
    )
    assert updated is not None
    assert updated.net_native == Decimal("250")
    assert updated.description == "edited"


def test_update_transaction_ignores_unknown_keys(session: Session) -> None:
    account_id = _account(session)
    txn = _insert(session, account_id)
    updated = transactions_repo.update_transaction(session, txn.id, not_a_column="x")
    assert updated is not None


def test_update_missing_transaction_returns_none(session: Session) -> None:
    assert transactions_repo.update_transaction(session, 9999, net_native=Decimal("1")) is None


def test_delete_transaction(session: Session) -> None:
    account_id = _account(session)
    txn = _insert(session, account_id)
    assert transactions_repo.delete_transaction(session, txn.id) is True
    assert transactions_repo.get_transaction(session, txn.id) is None


def test_delete_missing_transaction_returns_false(session: Session) -> None:
    assert transactions_repo.delete_transaction(session, 9999) is False


def test_find_account_money_market_instrument(session: Session) -> None:
    from investment_dashboard.repositories import instruments_repo

    account_id = _account(session)
    # A money-market settlement fund (known ticker) the account transacts in.
    vmfxx = instruments_repo.get_or_create(session, symbol="VMFXX")
    etf = instruments_repo.get_or_create(session, symbol="VTI")
    for instrument_id, kind in ((etf.id, "buy"), (vmfxx.id, "buy")):
        transactions_repo.insert_transaction(
            session,
            Transaction(
                account_id=account_id,
                date=date(2024, 1, 5),
                kind=kind,
                instrument_id=instrument_id,
                net_native=Decimal("-100"),
                source=TransactionSource.MANUAL,
            ),
        )
    found = transactions_repo.find_account_money_market_instrument(session, account_id)
    assert found is not None
    assert found.symbol == "VMFXX"


def test_find_account_money_market_instrument_none_when_absent(session: Session) -> None:
    from investment_dashboard.repositories import instruments_repo

    account_id = _account(session)
    etf = instruments_repo.get_or_create(session, symbol="VTI")
    transactions_repo.insert_transaction(
        session,
        Transaction(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="buy",
            instrument_id=etf.id,
            net_native=Decimal("-100"),
            source=TransactionSource.MANUAL,
        ),
    )
    assert transactions_repo.find_account_money_market_instrument(session, account_id) is None
