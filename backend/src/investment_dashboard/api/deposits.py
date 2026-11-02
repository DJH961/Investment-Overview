"""``/api/deposits`` -- contribution KPIs, the cash-flow ledger and dividend income."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Query

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.deposits import DepositsOut, DividendsOut
from investment_dashboard.readmodels import deposits as deposits_rm

router = APIRouter(prefix="/deposits", tags=["deposits"])


@router.get("", response_model=DepositsOut)
def get_deposits(
    session: SessionDep,
    ccy: ReportCcy = "EUR",
    account_id: int | None = Query(None, ge=1),
    kind: Literal["deposit", "withdrawal", "transfer"] | None = Query(
        None, description="Row filter; transfer = in + out."
    ),
    year: int | None = Query(None, ge=1900, le=2200, description="Row filter."),
) -> dict[str, Any]:
    return deposits_rm.build_for_ccy(session, ccy=ccy, account_id=account_id, kind=kind, year=year)


@router.get("/dividends", response_model=DividendsOut)
def get_dividends(session: SessionDep, ccy: ReportCcy = "EUR") -> dict[str, Any]:
    return deposits_rm.build_dividends(session, ccy=ccy)
