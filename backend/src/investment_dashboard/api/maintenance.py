"""``/api/maintenance``: Health & Repair — jobs, scheduler, logs, backups, market data.

Every write here needs a signed-in **browser session** (not the API token);
typed-confirmation jobs also go through the fresh-session hook
(:mod:`investment_dashboard.api.guards`). Reads work for any authenticated
caller. Job runs are 202 + ``{run}``; follow them with ``GET /maintenance/runs/{id}``
or the SSE ``job`` event.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from investment_dashboard.api.deps import SessionDep
from investment_dashboard.api.guards import SessionActorDep, require_fresh, require_session
from investment_dashboard.api.schemas.maintenance import (
    AnomaliesDto,
    BackupsDto,
    JobCatalogue,
    JobRun,
    JobStart,
    LogsDto,
    MaintenanceErrorDto,
    ManualClose,
    ManualRate,
    ManualSplit,
    PricesDto,
    ProbeRequest,
    ProbeResult,
    RatesDto,
    SchedulerPause,
    SchedulerState,
    SplitsDto,
)
from investment_dashboard.errors import ValidationError
from investment_dashboard.services import (
    backup_service,
    fx_service,
    job_runner,
    log_view_service,
    maintenance_service,
    prices_service,
    scheduler,
    settings_service,
)

router = APIRouter(prefix="/maintenance", tags=["maintenance"])

_ERRORS: dict[int | str, dict[str, Any]] = {422: {"model": MaintenanceErrorDto}}


def _dec(raw: str, what: str) -> Decimal:
    try:
        return Decimal(raw)
    except InvalidOperation as exc:
        raise ValidationError(f"{what} must be a number") from exc


# -- jobs -------------------------------------------------------------------------


@router.get("/jobs", response_model=JobCatalogue)
def get_jobs() -> dict[str, Any]:
    return maintenance_service.catalogue()


@router.post(
    "/jobs/{job_id}",
    response_model=JobRun,
    status_code=status.HTTP_202_ACCEPTED,
    responses=_ERRORS,
)
async def start_job(job_id: str, body: JobStart, request: Request) -> Any:
    spec = maintenance_service.get_spec(job_id)
    actor = await (require_fresh(request) if spec.danger == "typed" else require_session(request))
    try:
        run = await run_in_threadpool(
            maintenance_service.start_job, job_id, body.params, confirm=body.confirm, actor=actor
        )
    except maintenance_service.JobParamsError as exc:
        return JSONResponse({"detail": str(exc), "errors": exc.errors}, status_code=422)
    return job_runner.run_view(run)


@router.get("/runs/{run_id}", response_model=JobRun)
def get_run(run_id: str) -> dict[str, Any]:
    run = job_runner.get_run(run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found (runs are kept in memory)")
    return job_runner.run_view(run)


@router.post("/probe", response_model=ProbeResult)
def probe(body: ProbeRequest, _actor: SessionActorDep) -> dict[str, Any]:
    from investment_dashboard.services import price_probe_service  # noqa: PLC0415

    symbol = body.symbol.upper()
    if body.provider == "yfinance":
        outcome = price_probe_service.probe_yfinance(symbol)
    else:
        outcome = price_probe_service.probe_tiingo(
            symbol, token=prices_service._resolve_tiingo_token()
        )
    return {
        **outcome.__dict__,
        "price": None if outcome.price is None else format(outcome.price, "f"),
    }


# -- scheduler ----------------------------------------------------------------------


def _scheduler(request: Request) -> scheduler.Scheduler | None:
    sched = getattr(request.app.state, "scheduler", None)
    return sched if isinstance(sched, scheduler.Scheduler) else None


@router.get("/scheduler", response_model=SchedulerState)
def get_scheduler(request: Request) -> dict[str, Any]:
    sched = _scheduler(request)
    if sched is None:
        return {"enabled": False, "heavy_job": job_runner.heavy_busy()}
    return sched.snapshot()


@router.post("/scheduler/{job}/run", response_model=SchedulerState)
def run_scheduler_job(job: str, request: Request, _actor: SessionActorDep) -> dict[str, Any]:
    sched = _scheduler(request)
    if sched is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "The scheduler is not running")
    try:
        sched.request_run(job)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    return sched.snapshot()


@router.put("/scheduler/pause", response_model=SchedulerState)
def pause_scheduler(body: SchedulerPause, request: Request, _actor: SessionActorDep) -> Any:
    now = datetime.now(UTC)
    until = None
    if body.paused:
        hours = body.hours or int(settings_service.get("scheduler.pause_default_hours"))
        until = now + timedelta(hours=hours)
    scheduler.set_pause(list(body.jobs), until=until, now=now)
    sched = _scheduler(request)
    if sched is None:
        return {"enabled": False, "heavy_job": job_runner.heavy_busy()}
    return sched.snapshot()


# -- logs and backups ---------------------------------------------------------------


@router.get("/logs", response_model=LogsDto)
async def get_logs(
    request: Request,
    source: str = Query("main", description="'main' or an activity subject."),
    level: str = Query("INFO", pattern="^(DEBUG|INFO|WARNING|ERROR)$"),
    limit: int = Query(200, ge=1, le=1000),
    contains: str | None = Query(None, max_length=100),
    tracebacks: bool = Query(False, description="Include tracebacks (browser session only)."),
) -> dict[str, Any]:
    if tracebacks:
        await require_session(request)
    if source not in log_view_service.sources():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown log {source!r}")
    entries = await run_in_threadpool(
        lambda: log_view_service.read(
            source=source, level=level, limit=limit, contains=contains, tracebacks=tracebacks
        )
    )
    return {
        "source": source,
        "sources": log_view_service.sources(),
        "entries": [e.__dict__ for e in entries],
    }


@router.get("/backups", response_model=BackupsDto)
def get_backups() -> dict[str, Any]:
    return {
        "configured": backup_service.is_configured(),
        "directory": str(backup_service.backup_dir()),
        "snapshots": backup_service.describe_snapshots(),
    }


# -- market data --------------------------------------------------------------------


@router.get("/prices/anomalies", response_model=AnomaliesDto)
def get_anomalies(session: SessionDep) -> dict[str, Any]:
    return {"instrument_ids": prices_service.list_anomalies(session)}


@router.get("/prices/{instrument_id}", response_model=PricesDto)
def get_prices(
    instrument_id: int, session: SessionDep, start: date | None = None, end: date | None = None
) -> dict[str, Any]:
    rows = prices_service.list_closes(session, instrument_id, start=start, end=end)
    return {
        "instrument_id": instrument_id,
        "closes": [{"date": d, "close": format(c, "f"), "source": s} for d, c, s in rows],
    }


@router.put("/prices/{instrument_id}/{on}", response_model=PricesDto)
def put_price(
    instrument_id: int, on: date, body: ManualClose, session: SessionDep, _a: SessionActorDep
) -> dict[str, Any]:
    prices_service.set_manual_close(session, instrument_id, on, _dec(body.close, "close"))
    return get_prices(instrument_id, session, start=on, end=on)


@router.delete("/prices/{instrument_id}/{on}", status_code=status.HTTP_204_NO_CONTENT)
def delete_price(instrument_id: int, on: date, session: SessionDep, _a: SessionActorDep) -> None:
    prices_service.clear_manual_close(session, instrument_id, on)


@router.get("/fx/{quote}", response_model=RatesDto)
def get_rates(
    quote: str, session: SessionDep, start: date | None = None, end: date | None = None
) -> dict[str, Any]:
    rows = fx_service.list_rates(session, quote, start=start, end=end)
    return {
        "base": "EUR",
        "quote": quote.upper(),
        "rates": [{"date": d, "rate": format(r, "f"), "source": s} for d, r, s in rows],
    }


@router.put("/fx/{quote}/{on}", response_model=RatesDto)
def put_rate(
    quote: str, on: date, body: ManualRate, session: SessionDep, _a: SessionActorDep
) -> dict[str, Any]:
    fx_service.set_manual_rate(session, quote, on, _dec(body.rate, "rate"))
    return get_rates(quote, session, start=on, end=on)


@router.delete("/fx/{quote}/{on}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rate(quote: str, on: date, session: SessionDep, _a: SessionActorDep) -> None:
    fx_service.clear_manual_rate(session, quote, on)


@router.get("/splits/{instrument_id}", response_model=SplitsDto)
def get_splits(instrument_id: int, session: SessionDep) -> dict[str, Any]:
    rows = prices_service.list_splits(session, instrument_id)
    return {
        "instrument_id": instrument_id,
        "splits": [{"date": d, "ratio": format(r, "f"), "source": s} for d, r, s in rows],
    }


@router.put("/splits/{instrument_id}/{on}", response_model=SplitsDto)
def put_split(
    instrument_id: int, on: date, body: ManualSplit, session: SessionDep, _a: SessionActorDep
) -> dict[str, Any]:
    prices_service.set_manual_split(session, instrument_id, on, _dec(body.ratio, "ratio"))
    return get_splits(instrument_id, session)


@router.delete("/splits/{instrument_id}/{on}", status_code=status.HTTP_204_NO_CONTENT)
def delete_split(instrument_id: int, on: date, session: SessionDep, _a: SessionActorDep) -> None:
    prices_service.delete_split(session, instrument_id, on)
