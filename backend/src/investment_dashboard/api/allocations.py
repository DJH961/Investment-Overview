"""``/api/allocations`` - current mix, saved targets, drift and the rebalance plan."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.allocations import (
    AllocationsResponse,
    RebalanceResponse,
    TargetIn,
    TargetOut,
)
from investment_dashboard.readmodels import allocations as allocations_readmodel
from investment_dashboard.readmodels import rebalance

router = APIRouter(tags=["allocations"])


@router.get("/allocations", response_model=AllocationsResponse)
def get_allocations(session: SessionDep, ccy: ReportCcy = "EUR") -> AllocationsResponse:
    return AllocationsResponse.model_validate(allocations_readmodel.build(session, ccy=ccy))


@router.put("/allocations", response_model=TargetOut)
def put_allocation(body: TargetIn, session: SessionDep) -> TargetOut:
    try:
        items = [(i.instrument_id, Decimal(i.weight_pct), i.no_buy) for i in body.items]
        saved = allocations_readmodel.save_target(
            session,
            target_id=body.id,
            name=body.name,
            active=body.active,
            allow_sell=body.allow_sell,
            display_currency=body.display_currency,
            items=items,
        )
    except InvalidOperation as exc:
        raise HTTPException(status_code=422, detail="Invalid weight") from exc
    except allocations_readmodel.AllocationConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except allocations_readmodel.AllocationInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return TargetOut.model_validate(saved)


@router.get("/allocations/rebalance", response_model=RebalanceResponse)
def get_rebalance_plan(
    session: SessionDep,
    amount: Annotated[Decimal, Query(ge=0, description="Cash to invest, in `ccy`.")],
    ccy: ReportCcy = "EUR",
    fractional: bool = False,
    allow_sell: bool | None = None,
    target_id: int | None = None,
) -> RebalanceResponse:
    try:
        plan = rebalance.build_target_plan(
            session,
            amount=amount,
            ccy=ccy,
            allow_fractional=fractional,
            allow_sell=allow_sell,
            target_id=target_id,
        )
    except rebalance.RebalanceInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return RebalanceResponse.model_validate(rebalance.plan_to_dict(plan))
