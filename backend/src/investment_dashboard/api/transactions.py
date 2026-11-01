"""``/api/transactions``: ledger list/detail plus manual create / edit / delete.

Like the v5 UI, imported rows are editable too (their settlement sweep stays
paired); only the ledger rows themselves are touched, never the broker file.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.common import OkResponse
from investment_dashboard.api.schemas.transactions import (
    TransactionOut,
    TransactionPage,
    TransactionWrite,
    TransactionWriteResult,
)
from investment_dashboard.readmodels import transactions as transactions_rm
from investment_dashboard.readmodels.queries.ledger_query import LedgerFilters
from investment_dashboard.services import transaction_edit_service as edit

router = APIRouter(tags=["transactions"])


def _input(body: TransactionWrite) -> edit.TransactionInput:
    return edit.TransactionInput(
        account_id=body.account_id,
        date=body.date,
        kind=body.kind.value,
        symbol=body.symbol,
        quantity=body.quantity,
        price=body.price,
        total=body.total,
        fees=body.fees,
        description=body.description,
        route_money_market=body.route_money_market,
    )


def _result(session: Session, result: edit.TransactionEditResult) -> TransactionWriteResult:
    txn_id = result.transaction.id
    row = transactions_rm.build_one(session, txn_id)
    assert row is not None
    return TransactionWriteResult(transaction=TransactionOut(**row), warnings=result.warnings)


@router.get("/transactions", response_model=TransactionPage)
def list_transactions(
    session: SessionDep,
    account_id: int | None = None,
    symbol: str | None = None,
    kind: str | None = None,
    source: str | None = None,
    start: date | None = None,
    end: date | None = None,
    q: Annotated[str | None, Query(description="Text search.")] = None,
    hide_sweeps: bool = True,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> TransactionPage:
    filters = LedgerFilters(
        account_id=account_id,
        instrument_symbol=symbol.strip().upper() if symbol else None,
        kind=kind or None,
        source=source or None,
        start=start,
        end=end,
        hide_settlement_sweeps=hide_sweeps,
        text=q,
    )
    return TransactionPage(
        **transactions_rm.build_page(session, filters=filters, limit=limit, offset=offset)
    )


@router.get("/transactions/{txn_id}", response_model=TransactionOut)
def get_transaction(txn_id: int, session: SessionDep) -> TransactionOut:
    row = transactions_rm.build_one(session, txn_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found")
    return TransactionOut(**row)


@router.post(
    "/transactions", response_model=TransactionWriteResult, status_code=status.HTTP_201_CREATED
)
def create_transaction(body: TransactionWrite, session: SessionDep) -> TransactionWriteResult:
    try:
        result = edit.create(session, _input(body))
    except edit.TransactionEditError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _result(session, result)


@router.put("/transactions/{txn_id}", response_model=TransactionWriteResult)
def update_transaction(
    txn_id: int, body: TransactionWrite, session: SessionDep
) -> TransactionWriteResult:
    try:
        result = edit.update(session, txn_id, _input(body))
    except edit.TransactionNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except edit.TransactionEditError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _result(session, result)


@router.delete("/transactions/{txn_id}", response_model=OkResponse)
def delete_transaction(txn_id: int, session: SessionDep) -> OkResponse:
    if not edit.delete(session, txn_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found")
    return OkResponse(detail="Deleted")
