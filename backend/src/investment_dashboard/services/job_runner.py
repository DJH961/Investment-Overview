"""Named background jobs with single flight and one shared "heavy job" mutex.

Generalises the single-flight refresh in ``api/ops.py``:

* every job runs on its own daemon thread; the same job never runs twice at once;
* jobs marked ``heavy`` (refresh, backfill, rebuild, reset ...) share one mutex,
  so they never overlap each other — the scheduler checks :func:`heavy_busy`
  and skips its tick while one runs;
* the last :data:`KEEP_RUNS` runs stay in memory; the last result per job is
  also stored in ``app_config`` (``maintenance.last.<job>``) so it survives a
  restart;
* every state change publishes a ``job`` event on :mod:`live_bus` (SSE).

Pure orchestration: what a job does lives in ``maintenance_service``.
"""

from __future__ import annotations

import json
import logging
import secrets
import threading
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal

from investment_dashboard.activity_log import activity
from investment_dashboard.errors import ConflictError
from investment_dashboard.services import live_bus

log = logging.getLogger(__name__)

KEEP_RUNS = 50
LAST_KEY_PREFIX = "maintenance.last."
Status = Literal["running", "succeeded", "failed"]
JobFn = Callable[[dict[str, Any]], dict[str, Any] | None]


class JobBusyError(ConflictError):
    """The job (or another heavy job) is already running -> 409."""


@dataclass(frozen=True)
class Run:
    id: str
    job: str
    params: dict[str, Any]
    actor: str
    status: Status
    started_at: datetime
    finished_at: datetime | None = None
    result: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class _State:
    running: dict[str, Run] = field(default_factory=dict)
    recent: deque[Run] = field(default_factory=lambda: deque(maxlen=KEEP_RUNS))
    heavy_job: str | None = None


_lock = threading.Lock()
_state = _State()


def heavy_busy() -> str | None:
    """Name of the heavy job running now, or ``None``."""
    with _lock:
        return _state.heavy_job


def running(job: str | None = None) -> list[Run]:
    with _lock:
        return [r for r in _state.running.values() if job is None or r.job == job]


def recent(limit: int = KEEP_RUNS) -> list[Run]:
    """Newest first (running ones included)."""
    with _lock:
        return list(reversed(_state.recent))[:limit]


def get_run(run_id: str) -> Run | None:
    with _lock:
        for run in _state.recent:
            if run.id == run_id:
                return run
    return None


def run_view(run: Run) -> dict[str, Any]:
    return {
        "id": run.id,
        "job": run.job,
        "params": run.params,
        "actor": run.actor,
        "status": run.status,
        "started_at": run.started_at.isoformat(),
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "result": run.result,
        "error": run.error,
    }


def _publish(run: Run) -> None:
    try:
        live_bus.bus.publish({"type": "job", "ts": datetime.now(UTC).isoformat(), **run_view(run)})
    except Exception:  # pragma: no cover - never fail a job over the bus
        log.debug("job event not published", exc_info=True)


def _store(run: Run) -> None:
    from investment_dashboard.db import config_session_scope  # noqa: PLC0415
    from investment_dashboard.services import app_config_service  # noqa: PLC0415

    try:
        with config_session_scope() as cfg:
            app_config_service.set_value(
                cfg, LAST_KEY_PREFIX + run.job, json.dumps(run_view(run), default=str)
            )
    except Exception:
        log.debug("could not persist the last result of %s", run.job, exc_info=True)


def last_stored(job: str) -> dict[str, Any] | None:
    """The persisted last run of ``job`` (survives restarts)."""
    from investment_dashboard.db import config_session_scope  # noqa: PLC0415
    from investment_dashboard.services import app_config_service  # noqa: PLC0415

    try:
        with config_session_scope() as cfg:
            raw = app_config_service.get(cfg, LAST_KEY_PREFIX + job)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def last_stored_all(jobs: list[str]) -> dict[str, dict[str, Any]]:
    """:func:`last_stored` for many jobs in one read."""
    from investment_dashboard.db import config_session_scope  # noqa: PLC0415
    from investment_dashboard.services import app_config_service  # noqa: PLC0415

    try:
        with config_session_scope() as cfg:
            raw = app_config_service.get_many(cfg, [LAST_KEY_PREFIX + j for j in jobs])
    except Exception:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for key, value in raw.items():
        if value:
            try:
                out[key.removeprefix(LAST_KEY_PREFIX)] = json.loads(value)
            except ValueError:
                continue
    return out


def _error_text(exc: BaseException) -> str:
    # The exception message only (no traceback) — it is shown in the browser.
    return f"{type(exc).__name__}: {exc}"[:500]


def start(
    job: str,
    fn: JobFn,
    params: dict[str, Any] | None = None,
    *,
    actor: str,
    heavy: bool = False,
    persist: bool = True,
    wait: bool = False,
) -> Run:
    """Start ``fn(params)`` on a thread and return its :class:`Run`.

    Raises :class:`JobBusyError` when ``job`` already runs, or when ``heavy`` and
    another heavy job runs. ``wait=True`` runs inline (tests, CLI).
    """
    params = dict(params or {})
    with _lock:
        if any(r.job == job for r in _state.running.values()):
            raise JobBusyError(f"{job} is already running")
        if heavy and _state.heavy_job is not None:
            raise JobBusyError(f"{_state.heavy_job} is running; try again when it has finished")
        run = Run(
            id=secrets.token_hex(8),
            job=job,
            params=params,
            actor=actor,
            status="running",
            started_at=datetime.now(UTC),
        )
        _state.running[run.id] = run
        _state.recent.append(run)
        if heavy:
            _state.heavy_job = job
    activity("system").info("job %s started by %s", job, actor)
    _publish(run)

    def body() -> None:
        try:
            result = fn(params)
        except Exception as exc:
            log.warning("job %s failed", job, exc_info=True)
            done = replace(
                run, status="failed", finished_at=datetime.now(UTC), error=_error_text(exc)
            )
        else:
            done = replace(
                run, status="succeeded", finished_at=datetime.now(UTC), result=result or None
            )
        _finish(done, heavy=heavy, persist=persist)

    if wait:
        body()
        return get_run(run.id) or run
    try:
        threading.Thread(target=body, name=f"inv-job-{job}", daemon=True).start()
    except Exception:  # pragma: no cover - thread creation failure
        _finish(replace(run, status="failed", error="could not start"), heavy=heavy, persist=False)
        raise
    return run


def _finish(done: Run, *, heavy: bool, persist: bool) -> None:
    with _lock:
        _state.running.pop(done.id, None)
        for i, old in enumerate(_state.recent):
            if old.id == done.id:
                _state.recent[i] = done
                break
        if heavy and _state.heavy_job == done.job:
            _state.heavy_job = None
    level = logging.INFO if done.status == "succeeded" else logging.WARNING
    activity("system").log(level, "job %s %s", done.job, done.status.upper())
    if persist:
        _store(done)
    _publish(done)


def reset_for_tests() -> None:
    with _lock:
        _state.running.clear()
        _state.recent.clear()
        _state.heavy_job = None
