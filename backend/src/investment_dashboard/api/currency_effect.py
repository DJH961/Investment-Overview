"""Currency page, Impact section (v7.2).

* ``GET /currency/effect/both?range=1d|1w|1m|3m|ytd|1y|3y|5y|10y|all|<year>`` - what the
  exchange rate did to the portfolio over the range, per reporting currency:
  headline returns and effect, the constant-currency series, the bridge, month and
  year bars with a month x year grid, the rolling 12-month effect, records, the
  per-holding three-way split, inside vs outside market hours and the tiles.

A plain read (not an activity-log line: reads are not logged, AGENTS.md).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.overview import _overview_both
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.currency_effect import (
    EFFECT_RANGE_PATTERN,
    CurrencyEffectOut,
)
from investment_dashboard.readmodels import currency_effect as currency_effect_readmodel
from investment_dashboard.services.read_cache import cached_read, conditional_both

router = APIRouter(prefix="/currency", tags=["currency"])


@cached_read
def _effect_both(session: Session, range_key: str) -> ByCurrency[CurrencyEffectOut]:
    overview = _overview_both(session=session)
    payloads = currency_effect_readmodel.build_effect_both(
        session,
        range_key,
        {
            "EUR": overview.EUR.model_dump(mode="json"),
            "USD": overview.USD.model_dump(mode="json"),
        },
    )
    return ByCurrency[CurrencyEffectOut].model_validate(
        {c: CurrencyEffectOut.model_validate(p) for c, p in payloads.items()}
    )


@router.get("/effect/both", response_model=ByCurrency[CurrencyEffectOut])
@conditional_both("currency_effect")
def get_currency_effect_both(
    request: Request,
    response: Response,
    session: SessionDep,
    range_key: Annotated[str, Query(alias="range", pattern=EFFECT_RANGE_PATTERN)] = "ytd",
) -> ByCurrency[CurrencyEffectOut]:
    return _effect_both(session=session, range_key=range_key)
