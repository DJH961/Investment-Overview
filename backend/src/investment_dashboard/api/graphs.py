"""Graph routes: ``GET /api/graphs/{range}`` plus the range pref and reload writes.

* ``GET /graphs/{range}`` - portfolio value over time (+ the other currency line).
* ``PUT /graphs/range`` - remember the Overview graph range (market-aware default).
* ``POST /graphs/{range}/reload`` - re-pull one graph's data on a daemon thread
  (single flight: a second request while one runs gets 409) and returns 202; a
  ``graphs`` event on ``/api/stream`` reports completion.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.api.deps import ReportCcy, SessionDep
from investment_dashboard.api.schemas.common import ByCurrency
from investment_dashboard.api.schemas.graphs import (
    GraphRange,
    GraphRangePref,
    GraphRangePrefResponse,
    GraphReloadResponse,
    GraphResponse,
)
from investment_dashboard.readmodels import live_graphs
from investment_dashboard.services import live_bus
from investment_dashboard.services.read_cache import (
    cached_read,
    conditional_both,
    register_warmer,
)

log = logging.getLogger(__name__)

router = APIRouter(tags=["graphs"])

_reload_lock = threading.Lock()
_reload_running: str | None = None


@router.put("/graphs/range", response_model=GraphRangePrefResponse)
def put_graph_range(body: GraphRangePref, session: SessionDep) -> GraphRangePrefResponse:
    default = live_graphs.remember_range(session, body.range)
    return GraphRangePrefResponse.model_validate({"range": body.range, "default_range": default})


@router.get("/graphs/{range_key}", response_model=GraphResponse)
@cached_read
def get_graph(
    range_key: GraphRange,
    session: SessionDep,
    ccy: ReportCcy = "EUR",
    compare: Annotated[
        bool, Query(description="Also return the other currency line (default on).")
    ] = True,
) -> GraphResponse:
    return GraphResponse.model_validate(
        live_graphs.build_graph(session, range_key=range_key, ccy=ccy, compare=compare)
    )


@router.get("/graphs/{range_key}/both", response_model=ByCurrency[GraphResponse])
@conditional_both("graphs")
def get_graph_both(
    range_key: GraphRange,
    request: Request,
    response: Response,
    session: SessionDep,
    compare: Annotated[
        bool, Query(description="Also return the other currency line (default on).")
    ] = True,
) -> ByCurrency[GraphResponse]:
    return _graph_both(session=session, range_key=range_key, compare=compare)


@cached_read
def _graph_both(
    session: Session, range_key: GraphRange, compare: bool = True
) -> ByCurrency[GraphResponse]:
    return ByCurrency[GraphResponse].model_validate(
        {
            c: GraphResponse.model_validate(
                live_graphs.build_graph(session, range_key=range_key, ccy=c, compare=compare)
            )
            for c in ("EUR", "USD")
        }
    )


register_warmer(lambda session: _graph_both(session=session, range_key="1d", compare=True))


def _run_reload(range_key: str) -> None:
    global _reload_running  # noqa: PLW0603
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415

    started = time.perf_counter()
    ok = True
    points: int | None = None
    try:
        with ledger_session_scope() as session:
            points = live_graphs.reload_range(session, range_key)
    except Exception:
        ok = False
        log.warning("graph reload %s failed", range_key, exc_info=True)
    finally:
        with _reload_lock:
            _reload_running = None
    elapsed = time.perf_counter() - started
    subject = activity("market_data")
    if ok:
        subject.info("graph reload %s done in %.1fs (points=%s)", range_key, elapsed, points)
    else:
        subject.warning("graph reload %s FAILED after %.1fs", range_key, elapsed)
    now = datetime.now(UTC)
    live_bus.bus.publish(
        {
            "type": "graphs",
            "ts": now.isoformat(),
            "market_state": live_bus.market_state(now),
            "range": range_key,
            "ok": ok,
            "points": points,
        }
    )


@router.post(
    "/graphs/{range_key}/reload",
    response_model=GraphReloadResponse,
    status_code=status.HTTP_202_ACCEPTED,
    responses={409: {"description": "A graph reload is already running"}},
)
def reload_graph(range_key: GraphRange) -> GraphReloadResponse:
    global _reload_running  # noqa: PLW0603
    with _reload_lock:
        if _reload_running is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, f"A {_reload_running} graph reload is already running"
            )
        _reload_running = range_key
    try:
        threading.Thread(
            target=_run_reload, args=(range_key,), name="inv-dashboard-graph-reload", daemon=True
        ).start()
    except Exception:  # pragma: no cover - thread creation failure
        with _reload_lock:
            _reload_running = None
        raise
    return GraphReloadResponse(range=range_key, status="started")
