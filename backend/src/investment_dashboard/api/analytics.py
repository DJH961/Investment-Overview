"""``/api/analytics`` -- equity curve, risk metrics and attribution in one currency."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request, Response

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.analytics import AnalyticsOut
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.readmodels import analytics as analytics_rm
from investment_dashboard.services.read_cache import cached_read, conditional_both

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("", response_model=AnalyticsOut)
@cached_read
def get_analytics(
    session: SessionDep,
    ccy: ReportCcy = "EUR",
    lookback_days: int = Query(
        365, ge=0, le=36500, description="Window in days; 0 = since the first transaction."
    ),
    full_curve: bool = Query(False, description="Draw the curve from inception."),
) -> dict[str, Any]:
    return analytics_rm.build_for_ccy(
        session, ccy=ccy, lookback_days=lookback_days, full_curve=full_curve
    )


@router.get("/both", response_model=ByCurrency[AnalyticsOut])
@conditional_both("analytics")
@cached_read
def get_analytics_both(
    request: Request,
    response: Response,
    session: SessionDep,
    lookback_days: int = Query(
        365, ge=0, le=36500, description="Window in days; 0 = since the first transaction."
    ),
    full_curve: bool = Query(False, description="Draw the curve from inception."),
) -> ByCurrency[AnalyticsOut]:
    return ByCurrency[AnalyticsOut].model_validate(
        {
            c: AnalyticsOut.model_validate(
                analytics_rm.build_for_ccy(
                    session, ccy=c, lookback_days=lookback_days, full_curve=full_curve
                )
            )
            for c in ("EUR", "USD")
        }
    )
