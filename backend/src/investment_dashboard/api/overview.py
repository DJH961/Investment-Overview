"""``GET /api/overview`` - KPIs, currency box, market verdict and movers."""

from __future__ import annotations

from fastapi import APIRouter

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.overview import OverviewResponse
from investment_dashboard.readmodels import overview as overview_readmodel

router = APIRouter(tags=["overview"])


@router.get("/overview", response_model=OverviewResponse)
def get_overview(session: SessionDep, ccy: ReportCcy = "EUR") -> OverviewResponse:
    return OverviewResponse.model_validate(overview_readmodel.build_overview(session, ccy=ccy))
