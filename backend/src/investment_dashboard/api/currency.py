"""Currency page routes (v7.0: the strip and the Today sub-tab, plan §5).

* ``GET /currency/both`` - Today block, lifetime block and strip tiles, per currency.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.overview import _overview_both
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.currency import CurrencyOut
from investment_dashboard.readmodels import currency as currency_readmodel
from investment_dashboard.services.read_cache import (
    cached_read,
    conditional_both,
    register_warmer,
)

router = APIRouter(prefix="/currency", tags=["currency"])


@cached_read
def _currency_both(session: Session) -> ByCurrency[CurrencyOut]:
    """EUR and USD currency payloads, built from the (cached) Overview of each side."""
    overview = _overview_both(session=session)
    payloads = currency_readmodel.build_currency_both(
        session,
        {
            "EUR": overview.EUR.model_dump(mode="json"),
            "USD": overview.USD.model_dump(mode="json"),
        },
    )
    return ByCurrency[CurrencyOut].model_validate(
        {c: CurrencyOut.model_validate(p) for c, p in payloads.items()}
    )


@router.get("/both", response_model=ByCurrency[CurrencyOut])
@conditional_both("currency")
def get_currency_both(
    request: Request, response: Response, session: SessionDep
) -> ByCurrency[CurrencyOut]:
    return _currency_both(session=session)


register_warmer(lambda session: _currency_both(session=session))
