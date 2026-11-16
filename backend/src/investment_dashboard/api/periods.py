"""``/api/periods`` -- monthly and yearly growth tables in one reporting currency."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query, Request, Response

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.periods import PeriodsOut
from investment_dashboard.readmodels import periods as periods_rm
from investment_dashboard.services.read_cache import cached_read, conditional_both

router = APIRouter(prefix="/periods", tags=["periods"])


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
