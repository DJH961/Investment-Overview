"""``GET /api/holdings`` - one row per instrument in the reporting currency."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.holdings import (
    GroupBy,
    HistoryMode,
    HistoryRange,
    HoldingHistoryResponse,
    HoldingPeekResponse,
    HoldingPeeksResponse,
    HoldingsResponse,
    HoldingTwinResponse,
    TwinRange,
)
from investment_dashboard.readmodels import holding_detail, holding_peek
from investment_dashboard.readmodels import holdings as holdings_readmodel
from investment_dashboard.services.read_cache import (
    cached_read,
    conditional_both,
    register_warmer,
)

router = APIRouter(tags=["holdings"])


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


@cached_read
def _holdings_peeks(session: Session) -> HoldingPeeksResponse:
    return HoldingPeeksResponse.model_validate({"peeks": holding_peek.build_all(session)})


@router.get("/holdings/peeks", response_model=HoldingPeeksResponse)
def get_holding_peeks(session: SessionDep) -> HoldingPeeksResponse:
    return _holdings_peeks(session=session)


@router.get("/holdings/{instrument_id}/history", response_model=HoldingHistoryResponse)
@cached_read
def get_holding_history(
    session: SessionDep,
    instrument_id: int,
    range: HistoryRange = "1y",
    mode: HistoryMode = "price",
) -> HoldingHistoryResponse:
    body = holdings_readmodel.build_history(session, instrument_id, range_key=range, mode=mode)
    if body is None:
        raise HTTPException(404, detail="Unknown instrument.")
    return HoldingHistoryResponse.model_validate(body)


@router.get("/holdings/{instrument_id}/twin", response_model=HoldingTwinResponse)
@cached_read
def get_holding_twin(
    session: SessionDep,
    instrument_id: int,
    range: TwinRange = "1d",
) -> HoldingTwinResponse:
    body = holding_detail.build_twin(session, instrument_id, range_key=range)
    if body is None:
        raise HTTPException(404, detail="Unknown instrument or no ETF twin set.")
    return HoldingTwinResponse.model_validate(body)


@router.get("/holdings/{instrument_id}/peek", response_model=HoldingPeekResponse)
@cached_read
def get_holding_peek(session: SessionDep, instrument_id: int) -> HoldingPeekResponse:
    body = holding_peek.build(session, instrument_id)
    if body is None:
        raise HTTPException(404, detail="Unknown instrument.")
    return HoldingPeekResponse.model_validate(body)


register_warmer(lambda session: _holdings_both(session=session, group_by="none"))
register_warmer(lambda session: _holdings_peeks(session=session))
