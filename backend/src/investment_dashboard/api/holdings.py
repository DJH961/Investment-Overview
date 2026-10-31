"""``GET /api/holdings`` - one row per instrument in the reporting currency."""

from __future__ import annotations

from fastapi import APIRouter

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.holdings import HoldingsResponse
from investment_dashboard.readmodels import holdings as holdings_readmodel

router = APIRouter(tags=["holdings"])


@router.get("/holdings", response_model=HoldingsResponse)
def get_holdings(session: SessionDep, ccy: ReportCcy = "EUR") -> HoldingsResponse:
    return HoldingsResponse.model_validate(holdings_readmodel.build(session, ccy=ccy))
