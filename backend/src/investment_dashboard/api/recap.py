"""Month and year recap routes (7.4 P8).

* ``GET /recap?period=YYYY-MM|YYYY`` - the recap of one period in EUR and USD
  (default: the last finished month, in January the last finished year), with
  ``due`` for the Overview's first-visit card.
* ``POST /recap/ack`` - the owner dismissed it: ``recap.last_ack`` = that period
  (logged in the activity log). The figures do not depend on it, so the read cache
  stays.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.schemas.recap import RecapAckIn, RecapAckOut, RecapOut
from investment_dashboard.readmodels import recap as recap_rm

router = APIRouter(prefix="/recap", tags=["recap"])


@router.get("", response_model=RecapOut)
def get_recap(
    session: SessionDep,
    period: str | None = Query(None, description="YYYY-MM or YYYY"),
) -> RecapOut:
    if period is not None and not recap_rm.valid_period(period):
        raise HTTPException(422, "period must be YYYY-MM or YYYY")
    return RecapOut.model_validate(recap_rm.build(session, period=period))


@router.post("/ack", response_model=RecapAckOut)
def ack_recap(body: RecapAckIn, session: SessionDep) -> RecapAckOut:
    period = body.period or recap_rm.state(session)["default_period"]
    recap_rm.ack(session, period)
    session.commit()
    return RecapAckOut(last_ack=period)
