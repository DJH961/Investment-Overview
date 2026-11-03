"""``GET /api/live``: the latest tick and the intraday points missed since ``since``.

A tab that comes back (its SSE stream was closed while hidden) calls this once
instead of refetching every page (docs/v6_speed_plan.md §4.4, R5). Served from
memory (:mod:`services.live_state`): no database work.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from investment_dashboard.api.schemas.live import LiveResponse
from investment_dashboard.api.schemas.stream import TickEvent, TickPoint
from investment_dashboard.services import live_state

router = APIRouter(tags=["live"])


@router.get("/live", response_model=LiveResponse)
def get_live(
    since: Annotated[int, Query(ge=0, description="Last tick seq the client has.")] = 0,
) -> LiveResponse:
    seq, latest, points = live_state.snapshot(since)
    return LiveResponse(
        seq=seq,
        tick=TickEvent.model_validate(latest) if latest is not None else None,
        missed_points=[TickPoint.model_validate(p) for p in points],
    )
