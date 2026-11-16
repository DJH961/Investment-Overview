"""Currency page routes (v7.0: the strip and the Today sub-tab, plan §5).

* ``GET /currency/both`` - Today block, lifetime block and strip tiles, per currency.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.currency import CurrencyOut

router = APIRouter(prefix="/currency", tags=["currency"])


@router.get("/both", response_model=ByCurrency[CurrencyOut])
def get_currency_both(
    request: Request, response: Response, session: SessionDep
) -> ByCurrency[CurrencyOut]:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, detail="contract stub")
