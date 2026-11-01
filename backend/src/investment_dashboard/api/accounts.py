"""``/api/accounts`` CRUD and the read-only ``/api/instruments`` list."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.accounts import AccountIn, AccountOut, InstrumentOut
from investment_dashboard.models import Account, Transaction
from investment_dashboard.repositories import accounts_repo, instruments_repo

router = APIRouter(tags=["accounts"])


def _tx_count(session: Session, account_id: int) -> int:
    stmt = select(func.count()).select_from(Transaction).where(Transaction.account_id == account_id)
    return int(session.scalar(stmt) or 0)


def _out(session: Session, row: Account) -> AccountOut:
    return AccountOut(
        id=row.id,
        account_label=row.account_label,
        broker=row.broker,
        native_currency=row.native_currency,
        account_type=row.account_type,
        active=row.active,
        transaction_count=_tx_count(session, row.id),
    )


@router.get("/accounts", response_model=list[AccountOut])
def list_accounts(session: SessionDep) -> list[AccountOut]:
    return [_out(session, a) for a in accounts_repo.list_accounts(session)]


@router.post("/accounts", response_model=AccountOut, status_code=201)
def create_account(body: AccountIn, session: SessionDep) -> AccountOut:
    row = accounts_repo.create_account(
        session,
        broker=body.broker,
        account_label=body.account_label,
        native_currency=body.native_currency,
        account_type=body.account_type,
    )
    return _out(session, row)


@router.put("/accounts/{account_id}", response_model=AccountOut)
def update_account(account_id: int, body: AccountIn, session: SessionDep) -> AccountOut:
    current = accounts_repo.get_account(session, account_id)
    if current is None:
        raise HTTPException(status_code=404, detail="account not found")
    changes_identity = (
        body.broker != current.broker or body.native_currency.upper() != current.native_currency
    )
    if changes_identity and _tx_count(session, account_id) > 0:
        # Ledger rows reference broker and currency; changing them would corrupt history.
        raise HTTPException(
            status_code=409,
            detail="broker and currency cannot change once the account has transactions",
        )
    row = accounts_repo.update_account(
        session,
        account_id,
        account_label=body.account_label,
        account_type=body.account_type,
        broker=body.broker,
        native_currency=body.native_currency,
    )
    return _out(session, row)


@router.delete("/accounts/{account_id}", status_code=204)
def delete_account(account_id: int, session: SessionDep) -> Response:
    row = accounts_repo.get_account(session, account_id)
    if row is None:
        raise HTTPException(status_code=404, detail="account not found")
    if _tx_count(session, account_id) > 0:
        raise HTTPException(status_code=409, detail="account has transactions")
    session.delete(row)
    session.flush()
    return Response(status_code=204)


@router.get("/instruments", response_model=list[InstrumentOut])
def list_instruments(session: SessionDep) -> list[InstrumentOut]:
    return [
        InstrumentOut(
            id=i.id,
            symbol=i.symbol,
            name=i.name,
            asset_class=i.asset_class,
            native_currency=i.native_currency,
        )
        for i in instruments_repo.list_instruments(session)
    ]
