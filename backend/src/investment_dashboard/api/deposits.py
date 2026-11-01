"""``/api/deposits`` -- contribution KPIs and the cash-flow ledger."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.deposits import DepositsOut
from investment_dashboard.readmodels import deposits as deposits_rm

router = APIRouter(prefix="/deposits", tags=["deposits"])


@router.get("", response_model=DepositsOut)
def get_deposits(
    session: SessionDep,
    ccy: ReportCcy = "EUR",
    account_id: int | None = Query(None, ge=1),
) -> dict[str, Any]:
    return deposits_rm.build_for_ccy(session, ccy=ccy, account_id=account_id)
