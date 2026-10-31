"""``/api/analytics`` -- equity curve, risk metrics and attribution in one currency."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.analytics import AnalyticsOut
from investment_dashboard.readmodels import analytics as analytics_rm

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("", response_model=AnalyticsOut)
def get_analytics(
    session: SessionDep,
    ccy: ReportCcy = "EUR",
    lookback_days: int = Query(365, ge=1, le=36500),
    full_curve: bool = Query(False, description="Draw the curve from inception."),
) -> dict[str, Any]:
    return analytics_rm.build_for_ccy(
        session, ccy=ccy, lookback_days=lookback_days, full_curve=full_curve
    )
