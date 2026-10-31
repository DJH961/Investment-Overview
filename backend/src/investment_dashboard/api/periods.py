"""``/api/periods`` -- monthly and yearly growth tables in one reporting currency."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.periods import PeriodsOut
from investment_dashboard.readmodels import periods as periods_rm

router = APIRouter(prefix="/periods", tags=["periods"])


@router.get("/monthly", response_model=PeriodsOut)
def monthly(
    session: SessionDep,
    ccy: ReportCcy = "EUR",
    fill_gaps: bool = Query(False, description="Pad empty months so the history is contiguous."),
) -> dict[str, Any]:
    return periods_rm.build_for_ccy(session, monthly=True, ccy=ccy, fill_gaps=fill_gaps)


@router.get("/yearly", response_model=PeriodsOut)
def yearly(session: SessionDep, ccy: ReportCcy = "EUR") -> dict[str, Any]:
    return periods_rm.build_for_ccy(session, monthly=False, ccy=ccy)
