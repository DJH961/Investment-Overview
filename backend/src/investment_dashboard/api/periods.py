"""``/api/periods`` -- monthly and yearly growth tables in one reporting currency."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Query, Request, Response

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.periods import PeriodsOut
from investment_dashboard.readmodels import periods as periods_rm
from investment_dashboard.services.read_cache import cached_read, conditional_both

router = APIRouter(prefix="/periods", tags=["periods"])


@router.get("/monthly", response_model=PeriodsOut)
@cached_read
def monthly(
    session: SessionDep,
    ccy: ReportCcy = "EUR",
    fill_gaps: bool = Query(False, description="Pad empty months so the history is contiguous."),
) -> dict[str, Any]:
    return periods_rm.build_for_ccy(session, monthly=True, ccy=ccy, fill_gaps=fill_gaps)


@router.get("/yearly", response_model=PeriodsOut)
@cached_read
def yearly(session: SessionDep, ccy: ReportCcy = "EUR") -> dict[str, Any]:
    return periods_rm.build_for_ccy(session, monthly=False, ccy=ccy)


@router.get("/{kind}/both", response_model=ByCurrency[PeriodsOut])
@conditional_both("periods")
@cached_read
def periods_both(
    kind: Literal["monthly", "yearly"],
    request: Request,
    response: Response,
    session: SessionDep,
    fill_gaps: bool = Query(False, description="Pad empty months (monthly only)."),
) -> ByCurrency[PeriodsOut]:
    monthly_kind = kind == "monthly"
    return ByCurrency[PeriodsOut].model_validate(
        {
            c: PeriodsOut.model_validate(
                periods_rm.build_for_ccy(
                    session, monthly=monthly_kind, ccy=c, fill_gaps=fill_gaps and monthly_kind
                )
            )
            for c in ("EUR", "USD")
        }
    )
