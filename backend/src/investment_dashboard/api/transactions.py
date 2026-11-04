"""``/api/transactions``: ledger list/detail plus manual create / edit / delete.

Like the v5 UI, imported rows are editable too (their settlement sweep stays
paired); only the ledger rows themselves are touched, never the broker file.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.common import OkResponse
from investment_dashboard.api.schemas.transactions import (
    ReconcileRequest,
    ReconcileResult,
    TransactionAll,
    TransactionOut,
    TransactionPage,
    TransactionWrite,
    TransactionWriteResult,
)
from investment_dashboard.readmodels import transactions as transactions_rm
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.queries.ledger_query import LedgerFilters
from investment_dashboard.services import manual_entry
from investment_dashboard.services import transaction_edit_service as edit
from investment_dashboard.services.read_cache import cached_read, conditional_both

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
    sort: Annotated[
        Literal["date", "symbol", "kind", "account", "quantity", "net"],
        Query(description="Sort key over the whole filtered set (net = native amount)."),
    ] = "date",
    order: Literal["asc", "desc"] = "desc",
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
        **transactions_rm.build_page(
            session, filters=filters, limit=limit, offset=offset, sort=sort, order=order
        )
    )


@router.get("/transactions/all", response_model=TransactionAll)
@conditional_both("transactions-all", deps=("ledger",))
@cached_read(deps=("ledger",))
def list_all_transactions(
    request: Request, response: Response, session: SessionDep
) -> TransactionAll:
    return TransactionAll.model_validate(transactions_rm.build_all(session))


@router.post("/transactions/reconcile", response_model=ReconcileResult)
def reconcile(body: ReconcileRequest) -> ReconcileResult:
    """Fill the missing one of quantity / price / total, or flag a mismatch."""
    figures = manual_entry.reconcile_trade(body.quantity, body.price, body.total)
    given = {"quantity": body.quantity, "price": body.price, "total": body.total}
    got = {"quantity": figures.quantity, "price": figures.price, "total": figures.total}
    filled = next(
        (k for k, v in given.items() if v is None and got[k] is not None and not figures.error),
        None,
    )
    places = {
        "quantity": Decimal("0.000001"),
        "price": Decimal("0.000001"),
        "total": Decimal("0.01"),
    }

    def out(key: str) -> str | None:
        value = got[key]
        if value is None:
            return None
        # A derived figure is rounded for the form; typed ones are echoed as-is.
        return dec(value.quantize(places[key]).normalize() if key == filled else value)

    return ReconcileResult(
        quantity=out("quantity"),
        price=out("price"),
        total=out("total"),
        error=figures.error,
        filled=filled,
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
