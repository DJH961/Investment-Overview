"""``GET /api/holdings`` - one row per instrument in the reporting currency."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.holdings import (
    GroupBy,
    HistoryRange,
    HoldingHistoryResponse,
    HoldingsResponse,
)
from investment_dashboard.readmodels import holdings as holdings_readmodel
from investment_dashboard.services.read_cache import (
    cached_read,
    conditional_both,
    register_warmer,
)

router = APIRouter(tags=["holdings"])


@router.get("/holdings", response_model=HoldingsResponse)
@cached_read
def get_holdings(
    session: SessionDep, ccy: ReportCcy = "EUR", group_by: GroupBy = "none"
) -> HoldingsResponse:
    return HoldingsResponse.model_validate(
        holdings_readmodel.build(session, ccy=ccy, group_by=group_by)
    )


@router.get("/holdings/both", response_model=ByCurrency[HoldingsResponse])
@conditional_both("holdings")
def get_holdings_both(
    request: Request, response: Response, session: SessionDep, group_by: GroupBy = "none"
) -> ByCurrency[HoldingsResponse]:
    return _holdings_both(session=session, group_by=group_by)


@cached_read
def _holdings_both(session: Session, group_by: GroupBy = "none") -> ByCurrency[HoldingsResponse]:
    return ByCurrency[HoldingsResponse].model_validate(
        {
            c: HoldingsResponse.model_validate(
                holdings_readmodel.build(session, ccy=c, group_by=group_by)
            )
            for c in ("EUR", "USD")
        }
    )


@router.get("/holdings/{instrument_id}/history", response_model=HoldingHistoryResponse)
@cached_read
def get_holding_history(
    session: SessionDep,
    instrument_id: int,
    range: HistoryRange = "1y",
) -> HoldingHistoryResponse:
    body = holdings_readmodel.build_history(session, instrument_id, range_key=range)
    if body is None:
        raise HTTPException(404, detail="Unknown instrument.")
    return HoldingHistoryResponse.model_validate(body)


register_warmer(lambda session: _holdings_both(session=session, group_by="none"))
