"""Currency page: "The dollar" and "What if" sections (v7.2).

* ``GET /currency/dollar/both?range=`` - the dollar as a position: the position
  card, "your next euro", the trend block, rolling 1M/3M/1Y changes and the
  section's stats, per reporting currency.
* ``GET /currency/scenarios/both`` - the rate slider rows, marks, stress table,
  sensitivity and "cushion or amplify", per reporting currency.

Both are built from the (cached) Overview of each side, so the lifetime figures
are the Overview's own.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.overview import _overview_both
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.currency_dollar import DollarOut, ScenariosOut
from investment_dashboard.api.schemas.currency_rate import RateRange
from investment_dashboard.readmodels import currency_dollar as dollar_readmodel
from investment_dashboard.readmodels import currency_scenarios as scenarios_readmodel
from investment_dashboard.services.read_cache import cached_read, conditional_both

router = APIRouter(prefix="/currency", tags=["currency"])


def _overview_payloads(session: Session) -> dict[str, dict[str, object]]:
    overview = _overview_both(session=session)
    return {
        "EUR": overview.EUR.model_dump(mode="json"),
        "USD": overview.USD.model_dump(mode="json"),
    }


@cached_read
def _dollar_both(session: Session, range_key: str) -> ByCurrency[DollarOut]:
    payloads = dollar_readmodel.build_dollar_both(session, _overview_payloads(session), range_key)
    return ByCurrency[DollarOut].model_validate(
        {c: DollarOut.model_validate(p) for c, p in payloads.items()}
    )


@cached_read
def _scenarios_both(session: Session) -> ByCurrency[ScenariosOut]:
    payloads = scenarios_readmodel.build_scenarios_both(session, _overview_payloads(session))
    return ByCurrency[ScenariosOut].model_validate(
        {c: ScenariosOut.model_validate(p) for c, p in payloads.items()}
    )


@router.get("/dollar/both", response_model=ByCurrency[DollarOut])
@conditional_both("currency_dollar")
def get_dollar_both(
    request: Request,
    response: Response,
    session: SessionDep,
    range_key: Annotated[RateRange, Query(alias="range")] = "1y",
) -> ByCurrency[DollarOut]:
    return _dollar_both(session=session, range_key=range_key)


@router.get("/scenarios/both", response_model=ByCurrency[ScenariosOut])
@conditional_both("currency_scenarios")
def get_scenarios_both(
    request: Request, response: Response, session: SessionDep
) -> ByCurrency[ScenariosOut]:
    return _scenarios_both(session=session)
