"""``GET /api/holdings/{instrument_id}/tranches`` - the FIFO purchase-tranche view."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.tranches import TranchesResponse
from investment_dashboard.readmodels import tranches as tranches_readmodel
from investment_dashboard.services.read_cache import cached_read

router = APIRouter(tags=["holdings"])


@router.get("/holdings/{instrument_id}/tranches", response_model=TranchesResponse)
@cached_read
def get_holding_tranches(session: SessionDep, instrument_id: int) -> TranchesResponse:
    body = tranches_readmodel.build(session, instrument_id)
    if body is None:
        raise HTTPException(404, detail="Unknown instrument.")
    return TranchesResponse.model_validate(body)
