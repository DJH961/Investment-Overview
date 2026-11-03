"""``GET /api/overview`` - KPIs, currency box, market verdict and movers."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.overview import OverviewResponse
from investment_dashboard.readmodels import overview as overview_readmodel
from investment_dashboard.services.read_cache import cached_read, conditional_both

router = APIRouter(tags=["overview"])


@router.get("/overview", response_model=OverviewResponse)
@cached_read
def get_overview(session: SessionDep, ccy: ReportCcy = "EUR") -> OverviewResponse:
    return OverviewResponse.model_validate(overview_readmodel.build_overview(session, ccy=ccy))


@router.get("/overview/both", response_model=ByCurrency[OverviewResponse])
@conditional_both("overview")
@cached_read
def get_overview_both(
    request: Request, response: Response, session: SessionDep
) -> ByCurrency[OverviewResponse]:
    """EUR and USD overview built in one session (loads are reused)."""
    return ByCurrency[OverviewResponse].model_validate(
        {
            c: OverviewResponse.model_validate(overview_readmodel.build_overview(session, ccy=c))
            for c in ("EUR", "USD")
        }
    )
