"""Daily Brief routes (v7.0, plan §3.1).

* ``GET /brief`` - the Brief for the window since the last acknowledgement. Its own
  endpoint, never inside the overview payload (a 304 there would bring a dismissed
  card back). ETag over the ledger/prices/FX generations plus the Brief's own key.
* ``POST /brief/ack`` - the owner saw it: advance ``brief.last_ack_at``. Bumps only
  the Brief's cache key; logged in the activity log.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.brief import BriefAckIn, BriefAckOut, BriefOut

router = APIRouter(prefix="/brief", tags=["brief"])


@router.get("", response_model=BriefOut)
def get_brief(request: Request, response: Response, session: SessionDep) -> BriefOut:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, detail="contract stub")


@router.post("/ack", response_model=BriefAckOut)
def ack_brief(body: BriefAckIn, session: SessionDep) -> BriefAckOut:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, detail="contract stub")
