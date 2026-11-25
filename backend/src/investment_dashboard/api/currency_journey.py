"""The "Follow your dollars" endpoints (7.4 contract §8).

* ``GET /currency/journey`` - where the converted dollars are now, the stage bridge
  and the cash-outs, per view (``/both`` + ETag pattern);
* ``GET /trail/{kind}/{id}`` - one transaction's (or conversion's) money trail;
* ``POST /cash-out/preview`` - the cash-out card for a conversion back, not saved
  (saving uses the conversion API).

Read-only: no activity line (contract §8).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.currency_journey import (
    CashOutOut,
    CashOutPreviewIn,
    JourneyBoth,
    TrailKind,
    TrailOut,
)
from investment_dashboard.readmodels import currency_journey as journey_readmodel
from investment_dashboard.readmodels import money_trail
from investment_dashboard.services.read_cache import cached_read, conditional_both

router = APIRouter(tags=["currency"])


def _inputs(session: Session) -> journey_readmodel.JourneyInputs | None:
    return journey_readmodel.load_inputs_cached(session)


@cached_read
def _journey_both(session: Session) -> JourneyBoth:
    inputs = _inputs(session=session)
    payload: dict[str, Any] = (
        journey_readmodel.empty_journey_both()
        if inputs is None
        else journey_readmodel.build_journey_both(inputs)
    )
    return JourneyBoth.model_validate(payload)


@router.get("/currency/journey", response_model=JourneyBoth)
@conditional_both("currency_journey")
def get_journey(request: Request, response: Response, session: SessionDep) -> JourneyBoth:
    return _journey_both(session=session)


@router.get("/trail/{kind}/{item_id}", response_model=TrailOut)
def get_trail(kind: TrailKind, item_id: int, session: SessionDep) -> TrailOut:
    inputs = _inputs(session=session)
    out = None if inputs is None else money_trail.build_trail(inputs, kind, item_id)
    if out is None:
        raise HTTPException(status_code=404, detail="no money trail for this item")
    return TrailOut.model_validate(out)


@router.post("/cash-out/preview", response_model=CashOutOut)
def preview_cash_out(body: CashOutPreviewIn, session: SessionDep) -> CashOutOut:
    inputs = _inputs(session=session)
    if inputs is None:
        raise HTTPException(status_code=409, detail="the cash pool is not available yet")
    usd, eur, fees = Decimal(body.usd_sent), Decimal(body.eur_received), Decimal(body.fees_eur)
    if usd <= 0 or eur <= 0 or fees < 0:
        raise HTTPException(status_code=422, detail="amounts must be positive")
    out = journey_readmodel.build_preview(
        inputs,
        usd_sent=usd,
        eur_received=eur,
        fees_eur=fees,
        on=body.date,
        withdrawal_id=body.withdrawal_id,
    )
    return CashOutOut.model_validate(out)
