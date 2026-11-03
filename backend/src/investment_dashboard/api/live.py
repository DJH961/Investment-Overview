"""``GET /api/live``: the latest tick and the intraday points missed since ``since``.

A tab that comes back (its SSE stream was closed while hidden) calls this once
instead of refetching every page (docs/v6_speed_plan.md §4.4, R5).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from investment_dashboard.api.schemas.live import LiveResponse

router = APIRouter(tags=["live"])


@router.get("/live", response_model=LiveResponse)
def get_live(
    since: Annotated[int, Query(ge=0, description="Last tick seq the client has.")] = 0,
) -> LiveResponse:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "not built yet")  # filled in by task B
