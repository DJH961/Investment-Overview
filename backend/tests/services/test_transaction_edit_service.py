"""Manual transaction create / edit / delete incl. the money-market leg."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    transactions_repo,
)
from investment_dashboard.services import transaction_edit_service as svc
from investment_dashboard.services.transaction_edit_service import TransactionInput


@pytest.fixture
def account_id(session: Session) -> int:
    fx_repo.upsert_rates(session, {date(2024, 1, 5): Decimal("1.25")})
    return accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="V",
        native_currency="USD",
        account_type="brokerage",
    ).id


def _seed_vmfxx(session: Session, account_id: int) -> int:
    vmfxx = instruments_repo.get_or_create(session, symbol="VMFXX")
    transactions_repo.insert_transaction(
        session,
        Transaction(
            account_id=account_id,
            instrument_id=vmfxx.id,
            date=date(2023, 1, 1),
            kind="buy",
            net_native=Decimal("-1"),
            source=TransactionSource.MANUAL,
        ),
    )
    return vmfxx.id


def _deposit(account_id: int, total: str, **kw: object) -> TransactionInput:
    return TransactionInput(
        account_id=account_id,
        date=date(2024, 1, 5),
        kind="deposit",
        total=Decimal(total),
        **kw,  # type: ignore[arg-type]
    )


def test_create_cash_freezes_both_legs(session: Session, account_id: int) -> None:
    res = svc.create(session, _deposit(account_id, "100"))
    txn = res.transaction
    assert txn.net_native == Decimal("100")
    assert txn.net_usd == Decimal("100")
    assert txn.net_eur == Decimal("80.000000")  # 100 / 1.25 at the trade-date rate
    assert res.warnings == []


def test_trade_reconciles_missing_third_figure(session: Session, account_id: int) -> None:
    res = svc.create(
        session,
        TransactionInput(
            account_id=account_id,
            date=date(2024, 1, 5),
            kind="buy",
            symbol="vt",
            quantity=Decimal("4"),
            total=Decimal("400"),
        ),
    )
    assert res.transaction.price_native == Decimal("100")
    assert res.transaction.net_native == Decimal("-400")


def test_leg_lifecycle(session: Session, account_id: int) -> None:
    vmfxx_id = _seed_vmfxx(session, account_id)
    parent = svc.create(session, _deposit(account_id, "1000", route_money_market=True)).transaction
    leg = transactions_repo.find_settlement_leg(
        session, account_id=account_id, parent_external_id=parent.external_id
    )
    assert leg is not None
    assert leg.instrument_id == vmfxx_id
    assert leg.net_native == Decimal("-1000")

    svc.update(session, parent.id, _deposit(account_id, "1500"))
    session.refresh(leg)
    assert leg.net_native == Decimal("-1500")
    assert leg.quantity == Decimal("1500")

    assert svc.delete(session, parent.id) is True
    assert transactions_repo.get_transaction(session, leg.id) is None
    assert svc.delete(session, parent.id) is False


def test_update_missing_raises(session: Session, account_id: int) -> None:
    with pytest.raises(svc.TransactionNotFoundError):
        svc.update(session, 12345, _deposit(account_id, "1"))


def test_create_rejects_bad_kind_and_account(session: Session, account_id: int) -> None:
    with pytest.raises(svc.TransactionEditError):
        svc.create(
            session, TransactionInput(account_id=account_id, date=date(2024, 1, 5), kind="x")
        )
    with pytest.raises(svc.TransactionEditError):
        svc.create(session, _deposit(777, "1"))
