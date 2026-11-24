"""Daily Brief routes (v7.0, plan §3.1).

* ``GET /brief`` - the Brief for the window since the previous visit (every read here
  is also a visit heartbeat, see ``deps.visit_heartbeat``). Its own
  endpoint, never inside the overview payload (a 304 there would bring a dismissed
  card back). ETag over the ledger/prices/FX generations plus the Brief's own key.
* ``PUT/DELETE /brief/visit`` - debugging: set / clear the visit window by hand.
* ``POST /brief/ack`` - the owner dismissed it: advance ``brief.last_ack_at`` (hides it
  for this visit). Bumps only the Brief's cache key; logged in the activity log.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from investment_dashboard.api.deps import SessionDep, visit_heartbeat
from investment_dashboard.api.overview import _overview_both
from investment_dashboard.api.schemas.brief import BriefAckIn, BriefAckOut, BriefOut, BriefVisitIn
from investment_dashboard.domain import clock
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

router = APIRouter(prefix="/brief", tags=["brief"], dependencies=[Depends(visit_heartbeat)])

_DEPS = (LEDGER, PRICES, FX, BRIEF)


def _utcnow() -> datetime:
    """The server clock (a seam for tests)."""
    return clock.now()


@cached_read(deps=_DEPS)
def _brief(session: Session) -> BriefOut:
    now = _utcnow()
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
            raise HTTPException(422, "bad seen_at") from exc
    marker = brief_service.ack(session, seen_at=seen, now=_utcnow())
    session.commit()
    read_cache.invalidate(BRIEF)
    return BriefAckOut(last_ack_at=marker.isoformat())


@router.put("/visit", response_model=BriefOut)
def set_visit(body: BriefVisitIn, session: SessionDep) -> BriefOut:
    """Debug: set the current visit's window start by hand; the visit continues."""
    try:
        visit_from = datetime.fromisoformat(body.visit_from)
    except ValueError as exc:
        raise HTTPException(422, "bad visit_from") from exc
    if visit_from.tzinfo is None:
        raise HTTPException(422, "visit_from needs an offset")
    try:
        brief_service.set_visit_from(session, visit_from, now=_utcnow())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    session.commit()
    read_cache.invalidate(BRIEF)
    return _brief(session=session)  # type: ignore[no-any-return]


@router.delete("/visit", response_model=BriefOut)
def clear_visit(session: SessionDep) -> BriefOut:
    """Back to automatic: the next absence rolls the window as normal."""
    brief_service.clear_visit(session)
    session.commit()
    read_cache.invalidate(BRIEF)
    return _brief(session=session)  # type: ignore[no-any-return]
