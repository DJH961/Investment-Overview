"""Daily Brief routes (v7.0, plan §3.1).

* ``GET /brief`` - the Brief for the window since the last acknowledgement. Its own
  endpoint, never inside the overview payload (a 304 there would bring a dismissed
  card back). ETag over the ledger/prices/FX generations plus the Brief's own key.
* ``POST /brief/ack`` - the owner saw it: advance ``brief.last_ack_at``. Bumps only
  the Brief's cache key; logged in the activity log.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.overview import _overview_both
from investment_dashboard.api.schemas.brief import BriefAckIn, BriefAckOut, BriefOut
from investment_dashboard.readmodels import brief as brief_readmodel
from investment_dashboard.services import brief_service, read_cache
from investment_dashboard.services.read_cache import (
    BRIEF,
    FX,
    LEDGER,
    PRICES,
    cached_read,
    conditional_both,
)

router = APIRouter(prefix="/brief", tags=["brief"])

_DEPS = (LEDGER, PRICES, FX, BRIEF)


def _utcnow() -> datetime:
    """The server clock (a seam for tests)."""
    return datetime.now(UTC)


@cached_read(deps=_DEPS)
def _brief(session: Session) -> BriefOut:
    now = _utcnow()
    if brief_service.get_last_ack(session) is None:
        # First visit ever: no Brief, the window starts now.
        brief_service.init_marker(session, now)
        return BriefOut(due=False, last_ack_at=now.isoformat(), now=now.isoformat())
    # Build the window first: the (expensive) overview is only needed when one is due.
    probe = brief_readmodel.build(session, overview_both=None, now=now)
    if not probe["due"]:
        return BriefOut.model_validate(probe)
    return BriefOut.model_validate(
        brief_readmodel.build(session, overview_both=_overview_both(session=session), now=now)
    )


@router.get("", response_model=BriefOut)
@conditional_both("brief", deps=_DEPS)
def get_brief(request: Request, response: Response, session: SessionDep) -> BriefOut:
    return _brief(session=session)  # type: ignore[no-any-return]


@router.post("/ack", response_model=BriefAckOut)
def ack_brief(body: BriefAckIn, session: SessionDep) -> BriefAckOut:
    seen: datetime | None = None
    if body.seen_at is not None:
        try:
            seen = datetime.fromisoformat(body.seen_at)
        except ValueError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "bad seen_at") from exc
    marker = brief_service.ack(session, seen_at=seen, now=_utcnow())
    session.commit()
    read_cache.invalidate(BRIEF)
    return BriefAckOut(last_ack_at=marker.isoformat())
