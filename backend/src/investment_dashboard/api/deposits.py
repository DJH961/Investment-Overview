"""``/api/deposits`` -- contribution KPIs, the cash-flow ledger and dividend income."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Query, Request, Response

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.deposits import DepositsOut, DividendsOut
from investment_dashboard.readmodels import deposits as deposits_rm
from investment_dashboard.services.read_cache import cached_read, conditional_both

router = APIRouter(prefix="/deposits", tags=["deposits"])


@router.get("", response_model=DepositsOut)
@cached_read
def get_deposits(
    session: SessionDep,
    ccy: ReportCcy = "EUR",
    account_id: int | None = Query(None, ge=1),
    kind: Literal["deposit", "withdrawal", "transfer"] | None = Query(
        None, description="Row filter; transfer = in + out."
    ),
    year: int | None = Query(None, ge=1900, le=2200, description="Row filter."),
) -> dict[str, Any]:
    return deposits_rm.build_for_ccy(session, ccy=ccy, account_id=account_id, kind=kind, year=year)


@router.get("/dividends", response_model=DividendsOut)
@cached_read
def get_dividends(session: SessionDep, ccy: ReportCcy = "EUR") -> dict[str, Any]:
    return deposits_rm.build_dividends(session, ccy=ccy)


@router.get("/both", response_model=ByCurrency[DepositsOut])
@conditional_both("deposits")
@cached_read
def get_deposits_both(
    request: Request,
    response: Response,
    session: SessionDep,
    account_id: int | None = Query(None, ge=1),
    kind: Literal["deposit", "withdrawal", "transfer"] | None = Query(
        None, description="Row filter; transfer = in + out."
    ),
    year: int | None = Query(None, ge=1900, le=2200, description="Row filter."),
) -> ByCurrency[DepositsOut]:
    return ByCurrency[DepositsOut].model_validate(
        {
            c: DepositsOut.model_validate(
                deposits_rm.build_for_ccy(
                    session, ccy=c, account_id=account_id, kind=kind, year=year
                )
            )
            for c in ("EUR", "USD")
        }
    )


@router.get("/dividends/both", response_model=ByCurrency[DividendsOut])
@conditional_both("dividends")
@cached_read
def get_dividends_both(
    request: Request, response: Response, session: SessionDep
) -> ByCurrency[DividendsOut]:
    return ByCurrency[DividendsOut].model_validate(
        {
            c: DividendsOut.model_validate(deposits_rm.build_dividends(session, ccy=c))
            for c in ("EUR", "USD")
        }
    )
