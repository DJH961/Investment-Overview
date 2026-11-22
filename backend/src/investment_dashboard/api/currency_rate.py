"""Currency page rate chart (v7.2).

* ``GET /currency/rate-history?range=1d|1w|1m|3m|ytd|1y|all|5y|10y|max`` - EUR/USD
  points, MA200, the lifetime average rate, low/high/change, the dollar's trend,
  "dollar cheaper than today" percentiles and conversion markers. One payload for
  both reporting currencies (a market rate, not a portfolio figure).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.overview import _overview_both
from investment_dashboard.api.schemas.currency_rate import RateHistoryOut, RateRange
from investment_dashboard.readmodels import currency_rate as currency_rate_readmodel
from investment_dashboard.services.read_cache import cached_read, conditional_both

router = APIRouter(prefix="/currency", tags=["currency"])


@cached_read
def _rate_history(session: Session, range_key: str) -> RateHistoryOut:
    # The Overview's own lifetime block (cached), so both pages show one number.
    lifetime = _overview_both(session=session).EUR.currency.lifetime
    avg = lifetime.avg_invest_rate
    payload = currency_rate_readmodel.build_rate_history(
        session, range_key, avg_invest_rate=Decimal(avg) if avg is not None else None
    )
    return RateHistoryOut.model_validate(payload)


@router.get("/rate-history", response_model=RateHistoryOut)
@conditional_both("currency_rate_history")
def get_rate_history(
    request: Request,
    response: Response,
    session: SessionDep,
    range_key: Annotated[RateRange, Query(alias="range")] = "1y",
) -> RateHistoryOut:
    return _rate_history(session=session, range_key=range_key)
