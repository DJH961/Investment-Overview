"""``GET /api/holdings`` - one row per instrument in the reporting currency."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.holdings import (
    HistoryRange,
    HoldingHistoryResponse,
    HoldingsResponse,
)
from investment_dashboard.readmodels import holdings as holdings_readmodel

router = APIRouter(tags=["holdings"])


@router.get("/holdings", response_model=HoldingsResponse)
def get_holdings(session: SessionDep, ccy: ReportCcy = "EUR") -> HoldingsResponse:
    return HoldingsResponse.model_validate(holdings_readmodel.build(session, ccy=ccy))


@router.get("/holdings/{instrument_id}/history", response_model=HoldingHistoryResponse)
def get_holding_history(
    session: SessionDep,
    instrument_id: int,
    range: HistoryRange = "1y",
) -> HoldingHistoryResponse:
    body = holdings_readmodel.build_history(session, instrument_id, range_key=range)
    if body is None:
        raise HTTPException(404, detail="Unknown instrument.")
    return HoldingHistoryResponse.model_validate(body)
