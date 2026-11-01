"""``/api/calculator`` -- inputs/defaults (GET) and the projection what-if (POST)."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from fastapi import APIRouter

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.calculator import (
    CalculatorInputsOut,
    ProjectionOut,
    ProjectionRequest,
)
from investment_dashboard.readmodels import calculator as calculator_rm
from investment_dashboard.readmodels import projection as projection_rm

router = APIRouter(prefix="/calculator", tags=["calculator"])

_PCT = Decimal(100)


@router.get("", response_model=CalculatorInputsOut)
def get_inputs(session: SessionDep, ccy: ReportCcy = "EUR") -> dict[str, Any]:
    return calculator_rm.build_inputs(session, ccy=ccy)


@router.post("", response_model=ProjectionOut)
def post_projection(
    body: ProjectionRequest, session: SessionDep, ccy: ReportCcy = "EUR"
) -> dict[str, Any]:
    seed = projection_rm.build_seed(session, monthly=body.monthly, primary=ccy)
    return projection_rm.project(
        seed,
        ccy=ccy,
        expected_rate=None if body.expected_return_pct is None else body.expected_return_pct,
        band=body.band_pp / _PCT,
        stepup=body.step_up_pct,
        inflation=body.inflation_pct,
        horizon=body.horizon,
        contribution=body.contribution,
        target=body.target,
        real=body.real,
    )
