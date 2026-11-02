"""In-process scheduler for the v6 server.

One asyncio loop; every job is blocking code run through ``asyncio.to_thread``.
Decisions use the New York exchange clock from :mod:`domain.market_hours`
(never ``date.today()``):

* market open  -> ``tick`` every auto-refresh interval (default 60 s): one
  batched price + FX refresh and an intraday sample (``auto_refresh.tick_refresh``,
  which also runs the Tiingo fallback inside ``prices_service``), then a ``tick``
  event;
* market closed -> ``eod`` once per settled session date (closes, splits,
  benchmark, snapshots, cache janitor), then a ``refresh`` event;
* otherwise the live FX spot every ``scheduler.fx_interval_minutes`` (default 30;
  ``fx`` event).

Control (``/api/maintenance/scheduler``): :meth:`Scheduler.snapshot` reports the
state, :meth:`Scheduler.request_run` runs a job on the next loop pass (it also
wakes the loop), and :func:`set_pause` pauses jobs until a time that always
expires (default ``scheduler.pause_default_hours``). Pauses are kept in memory
and in ``app_config`` (:data:`PAUSE_KEY`) so a restart keeps them. While a heavy
maintenance job runs (``job_runner.heavy_busy``) market jobs wait.

Clock, sleep, jobs and bus are injectable for tests.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import market_hours
from investment_dashboard.services import live_bus

log = logging.getLogger(__name__)

POLL_SECONDS = 5.0
#: Fallback when the ``scheduler.fx_interval_minutes`` setting cannot be read.
FX_INTERVAL = timedelta(minutes=30)
JOB_NAMES: tuple[str, ...] = ("tick", "fx", "eod", "backup")
PAUSE_KEY = "scheduler.pause"
#: Longest pause accepted (a pause always expires).
MAX_PAUSE = timedelta(days=7)
#: Minimum gap between backup attempts (also the retry delay after a failure).
BACKUP_RETRY = timedelta(minutes=1)

#: A job returns an extra payload merged into the published event (or ``None``).
Job = Callable[[], dict[str, Any] | None]
Clock = Callable[[], datetime]
Sleep = Callable[[float], Awaitable[None]]


def _event_ts(now: datetime) -> str:
    return now.astimezone(UTC).isoformat()


def _dec(value: Decimal | None) -> str | None:
    return None if value is None else format(value, "f")


def _live_fx() -> Decimal | None:
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    spot = fx_service.get_live_spot("USD")
    return None if spot is None else spot.rate


def default_tick_job() -> dict[str, Any] | None:
    from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415
    from investment_dashboard.services import auto_refresh, positions_service  # noqa: PLC0415

    auto_refresh.tick_refresh("Scheduled live refresh")
    rate = _live_fx()
    with ledger_session_scope() as session:
        total_eur = positions_service.total_portfolio_value(
            session, as_of=market_hours.exchange_today()
        )
    return {
        "total_value_eur": _dec(total_eur),
        # One instant (value now x spot now), so EUR -> USD is a valid conversion.
        "total_value_usd": _dec(total_eur * rate) if rate is not None else None,
        "fx_eur_usd": _dec(rate),
        **_price_freshness(),
    }


def _price_freshness(now: datetime | None = None) -> dict[str, Any]:
    """``last_update_at`` + ``prices_live`` for the tick event (Live vs Updated chip)."""
    from investment_dashboard.services import refresh_status  # noqa: PLC0415

    now = now or datetime.now(UTC)
    last = refresh_status.snapshot().last_update_at
    return {
        "last_update_at": last.isoformat() if last is not None else None,
        "prices_live": market_hours.is_live_now(
            market_open=market_hours.is_us_market_open(now), last_update_at=last, now=now
        ),
    }


def default_fx_job() -> dict[str, Any] | None:
    from investment_dashboard.services import fx_service  # noqa: PLC0415

    fx_service.refresh_live_spot()
    return {"fx_eur_usd": _dec(_live_fx())}


def default_eod_job() -> dict[str, Any] | None:
    from investment_dashboard import boot  # noqa: PLC0415

    for step in (
        boot._refresh_fx,
        boot._refresh_prices,
        boot._refresh_splits,
        boot._refresh_benchmark,
        boot._refresh_intraday_day,
        boot._warm_snapshots,
        boot._run_cache_janitor,
    ):
        step()  # each step catches and logs its own failure
    return None


def default_backup_job() -> dict[str, Any] | None:
    from investment_dashboard.services import backup_service  # noqa: PLC0415

    return backup_service.run_scheduled()


def default_backup_due(now: datetime) -> bool:
    from investment_dashboard.services import backup_service  # noqa: PLC0415

    return backup_service.is_due(now)


def default_interval() -> int:
    from investment_dashboard.db import config_session_scope  # noqa: PLC0415
    from investment_dashboard.services import auto_refresh  # noqa: PLC0415

    with config_session_scope() as session:
        return auto_refresh.get_interval_seconds(session)


def default_fx_interval() -> timedelta:
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    try:
        return timedelta(minutes=int(settings_service.get("scheduler.fx_interval_minutes")))
    except Exception:
        return FX_INTERVAL


def default_heavy_busy() -> str | None:
    from investment_dashboard.services import job_runner  # noqa: PLC0415

    return job_runner.heavy_busy()


# -- pauses ------------------------------------------------------------------------

_pause_lock = threading.Lock()
_pauses: dict[str, datetime] = {}
_pause_state = {"loaded": False}


def _load_pauses() -> None:
    if _pause_state["loaded"]:
        return
    _pause_state["loaded"] = True
    try:
        from investment_dashboard.db import config_session_scope  # noqa: PLC0415
        from investment_dashboard.services import app_config_service  # noqa: PLC0415

        with config_session_scope() as cfg:
            raw = app_config_service.get(cfg, PAUSE_KEY)
        for name, until in (json.loads(raw) if raw else {}).items():
            if name in JOB_NAMES:
                _pauses[name] = datetime.fromisoformat(until)
    except Exception:
        log.debug("could not load scheduler pauses", exc_info=True)


def _save_pauses() -> None:
    try:
        from investment_dashboard.db import config_session_scope  # noqa: PLC0415
        from investment_dashboard.services import app_config_service  # noqa: PLC0415

        payload = {k: v.isoformat() for k, v in _pauses.items()}
        with config_session_scope() as cfg:
            app_config_service.set_value(cfg, PAUSE_KEY, json.dumps(payload) if payload else None)
    except Exception:
        log.warning("could not persist scheduler pauses", exc_info=True)


def paused(now: datetime) -> dict[str, datetime]:
    """Jobs paused at ``now`` -> until when (expired pauses are dropped)."""
    with _pause_lock:
        _load_pauses()
        expired = [k for k, until in _pauses.items() if until <= now]
        for k in expired:
            del _pauses[k]
        if expired:
            _save_pauses()
        return dict(_pauses)


def set_pause(
    jobs: list[str], *, until: datetime | None, now: datetime | None = None
) -> dict[str, datetime]:
    """Pause ``jobs`` until ``until`` (``None`` resumes them). Returns all pauses."""
    now = now or datetime.now(UTC)
    unknown = [j for j in jobs if j not in JOB_NAMES]
    if unknown:
        raise ValueError(f"unknown scheduler job(s): {', '.join(unknown)}")
    if until is not None and not (now < until <= now + MAX_PAUSE):
        raise ValueError("a pause must end in the future and within 7 days")
    with _pause_lock:
        _load_pauses()
        for job in jobs:
            if until is None:
                _pauses.pop(job, None)
            else:
                _pauses[job] = until
        _save_pauses()
    activity("market_data").info(
        "scheduler %s: %s", "resumed" if until is None else f"paused until {until}", jobs
    )
    return paused(now)


def reset_pauses_for_tests() -> None:
    with _pause_lock:
        _pauses.clear()
        _pause_state["loaded"] = True


@dataclass
class Jobs:
    tick: Job = default_tick_job
    fx: Job = default_fx_job
    eod: Job = default_eod_job
    #: Sealed database snapshot (independent of market state, no live event).
    backup: Job = default_backup_job
    backup_due: Callable[[datetime], bool] = default_backup_due
    interval_seconds: Callable[[], int] = default_interval
    fx_interval: Callable[[], timedelta] = default_fx_interval
    #: Name of a running heavy maintenance job (market jobs wait), or ``None``.
    heavy_busy: Callable[[], str | None] = default_heavy_busy


@dataclass
class State:
    last_tick: datetime | None = None
    last_fx: datetime | None = None
    last_eod_session: date | None = None
    last_backup: datetime | None = None
    running: set[str] = field(default_factory=set)
    requested: set[str] = field(default_factory=set)
    last_runs: dict[str, datetime] = field(default_factory=dict)
    last_failed: dict[str, bool] = field(default_factory=dict)


class Scheduler:
    def __init__(
        self,
        *,
        jobs: Jobs | None = None,
        clock: Clock | None = None,
        sleep: Sleep | None = None,
        bus: live_bus.LiveBus | None = None,
        poll_seconds: float = POLL_SECONDS,
    ) -> None:
        self.jobs = jobs or Jobs()
        self.clock: Clock = clock or (lambda: datetime.now(UTC))
        self.sleep: Sleep = sleep or asyncio.sleep
        self.bus = bus or live_bus.bus
        self.poll_seconds = poll_seconds
        self.state = State()
        self._wake: asyncio.Event | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # -- control -----------------------------------------------------------

    def request_run(self, name: str) -> None:
        """Run ``name`` on the next pass (even when not due or paused); thread-safe."""
        if name not in JOB_NAMES:
            raise ValueError(f"unknown scheduler job {name!r}")
        self.state.requested.add(name)
        loop, wake = self._loop, self._wake
        if loop is not None and wake is not None:
            loop.call_soon_threadsafe(wake.set)

    def snapshot(self) -> dict[str, Any]:
        """JSON-safe state for the Health & Repair page."""
        now = self.clock()
        st = self.state

        def iso(value: datetime | None) -> str | None:
            return None if value is None else value.astimezone(UTC).isoformat()

        pauses = paused(now)
        return {
            "enabled": True,
            "now": iso(now),
            "market_state": live_bus.market_state(now),
            "jobs": [
                {
                    "name": name,
                    "running": name in st.running,
                    "requested": name in st.requested,
                    "last_run_at": iso(st.last_runs.get(name)),
                    "last_failed": st.last_failed.get(name, False),
                    "paused_until": iso(pauses.get(name)),
                }
                for name in JOB_NAMES
            ],
            "last_eod_session": (st.last_eod_session.isoformat() if st.last_eod_session else None),
            "heavy_job": self.jobs.heavy_busy(),
        }

    # -- decisions ---------------------------------------------------------

    def due(self, now: datetime, interval_seconds: int = 60) -> list[str]:
        """Names of the jobs that should run at ``now``."""
        names = self._due_market(now, interval_seconds)
        st = self.state
        if st.last_backup is None or now - st.last_backup >= BACKUP_RETRY:
            try:
                if self.jobs.backup_due(now):
                    names.append("backup")
            except Exception:
                log.warning("backup due-check failed", exc_info=True)
        return names

    def _due_market(self, now: datetime, interval_seconds: int) -> list[str]:
        st = self.state
        if market_hours.is_us_market_open(now):
            if st.last_tick is None or now - st.last_tick >= timedelta(seconds=interval_seconds):
                return ["tick"]
            return []
        if st.last_eod_session != market_hours.latest_settled_session_date(now):
            return ["eod"]
        if st.last_fx is None or now - st.last_fx >= self._fx_interval():
            return ["fx"]
        return []

    def _fx_interval(self) -> timedelta:
        try:
            return self.jobs.fx_interval()
        except Exception:
            return FX_INTERVAL

    # -- execution ---------------------------------------------------------

    async def _run_job(self, name: str, now: datetime) -> None:
        st = self.state
        if name in st.running:  # a job never overlaps itself
            return
        st.running.add(name)
        try:
            failed = False
            extra: dict[str, Any] | None = None
            started = time.perf_counter()
            subject = activity("backups" if name == "backup" else "market_data")
            try:
                extra = await asyncio.to_thread(getattr(self.jobs, name))
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("scheduler job %s failed", name, exc_info=True)
                subject.warning("job %s FAILED after %.1fs", name, time.perf_counter() - started)
                failed = True
            else:
                subject.info("job %s done in %.1fs", name, time.perf_counter() - started)
            # Mark done even on failure so a broken job retries at its normal
            # cadence instead of spinning every poll.
            st.last_runs[name] = now
            st.last_failed[name] = failed
            if name == "tick":
                st.last_tick = now
            elif name == "fx":
                st.last_fx = now
            elif name == "eod":
                st.last_eod_session = market_hours.latest_settled_session_date(now)
                st.last_fx = now
            elif name == "backup":
                st.last_backup = now
            if failed or name == "backup":
                return
            etype = {"tick": "tick", "fx": "fx", "eod": "refresh"}[name]
            event: live_bus.Event = {
                "type": etype,
                "ts": _event_ts(self.clock()),
                "market_state": live_bus.market_state(now),
            }
            event.update(extra or {})
            self.bus.publish(event)
        finally:
            st.running.discard(name)

    async def step(self) -> list[str]:
        """Evaluate once and run whatever is due. Returns the job names run."""
        now = self.clock()
        interval = 60
        if market_hours.is_us_market_open(now):
            try:
                interval = await asyncio.to_thread(self.jobs.interval_seconds)
            except Exception:
                log.warning("could not read refresh interval; using 60 s", exc_info=True)
        due = self.due(now, interval)
        pauses = paused(now)
        due = [n for n in due if n not in pauses]
        heavy = self.jobs.heavy_busy()
        if heavy is not None:
            # A heavy maintenance job owns the data; backups still run.
            due = [n for n in due if n == "backup"]
        requested = [n for n in JOB_NAMES if n in self.state.requested]
        self.state.requested.difference_update(requested)
        ran = [*due, *(n for n in requested if n not in due)]
        for name in ran:
            await self._run_job(name, now)
        return ran

    async def _pause_between_steps(self) -> None:
        if self.sleep is not asyncio.sleep:
            await self.sleep(self.poll_seconds)
            return
        wake = self._wake
        assert wake is not None
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(wake.wait(), self.poll_seconds)
        wake.clear()

    async def run(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        while True:
            try:
                await self.step()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("scheduler step failed")
            await self._pause_between_steps()
