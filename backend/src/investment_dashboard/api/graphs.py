"""``GET /api/graphs/{range}`` - portfolio value over time."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.graphs import GraphRange, GraphResponse
from investment_dashboard.readmodels import live_graphs

router = APIRouter(tags=["graphs"])


@router.get("/graphs/{range_key}", response_model=GraphResponse)
def get_graph(
    range_key: GraphRange,
    session: SessionDep,
    ccy: ReportCcy = "EUR",
    compare: Annotated[bool, Query(description="Also return the other currency line.")] = False,
) -> GraphResponse:
    return GraphResponse.model_validate(
        live_graphs.build_graph(session, range_key=range_key, ccy=ccy, compare=compare)
    )
