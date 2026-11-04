"""In-process scheduler for the v6 server.

One asyncio loop; every job is blocking code run through ``asyncio.to_thread``.
Decisions use the New York exchange clock from :mod:`domain.market_hours`
(never ``date.today()``):

Stocks and currencies are polled on two separate clocks, each with an "open" and
a "closed" interval from Settings:

* stocks (US market, ``is_us_market_open``): while open a ``tick`` every
  ``live_refresh_interval_seconds`` (default 60 s): a price refresh and an intraday
  sample (``auto_refresh.tick_refresh``, which also runs the Tiingo fallback inside
  ``prices_service``), then a ``tick`` event. While closed, ``eod`` once per
  settled session date (closes, splits, benchmark, snapshots, cache janitor; a
  ``refresh`` event), then a price ``tick`` without a sample every
  ``scheduler.closed_interval_minutes`` (default 10);
* currencies (24/5, ``is_forex_market_open``): the live EUR/USD spot (``fx``
  event) every ``scheduler.fx_interval_minutes`` (default 1) while the currency
  market trades, whatever the stock market does (so on a Tuesday night it is still
  checked every minute), and every ``scheduler.fx_closed_interval_minutes``
  (default 10) over the weekend.

A tick or FX check that changed nothing (same prices, same rate, no new sample)
is published with ``unchanged: True``: clients still see the check, but the read
cache is kept (see ``read_cache.invalidate_for_event``).

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
from investment_dashboard.services import live_bus, live_state, read_cache

log = logging.getLogger(__name__)

POLL_SECONDS = 5.0
#: Fallback when the ``scheduler.fx_interval_minutes`` setting cannot be read.
FX_INTERVAL = timedelta(minutes=1)
#: Fallback when the ``scheduler.closed_interval_minutes`` /
#: ``scheduler.fx_closed_interval_minutes`` settings cannot be read.
CLOSED_INTERVAL = timedelta(minutes=10)
#: Event fields that say whether a tick / FX check changed anything.
_CHANGE_KEYS = ("total_value_eur", "fx_eur_usd", "prices", "point")
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
    today = market_hours.exchange_today()
    # Outside the session a tick only checks prices: no intraday sample.
    session_open = market_hours.is_us_market_open()
    with ledger_session_scope() as session:
        total_eur = positions_service.total_portfolio_value(session, as_of=today)
        prices = _tick_prices(session, today)
        point = _tick_point(session, total_eur, rate) if session_open else None
    return {
        "total_value_eur": _dec(total_eur),
        # One instant (value now x spot now), so EUR -> USD is a valid conversion.
        "total_value_usd": _dec(total_eur * rate) if rate is not None else None,
        "fx_eur_usd": _dec(rate),
        "prices": prices,
        "point": point,
        **_price_freshness(),
    }


def _tick_prices(session: Any, today: date) -> dict[str, Any] | None:
    """Latest native price + previous close per held instrument (best effort)."""
    try:
        from investment_dashboard.services import (  # noqa: PLC0415
            positions_service,
            prices_service,
        )

        latest: dict[int, tuple[Decimal, str]] = {}
        for pos in positions_service.compute_positions(session, as_of=today):
            price = pos.current_price_native
            if price is not None and pos.shares != 0:
                latest[pos.instrument.id] = (price, pos.instrument.native_currency)
        recent = prices_service.recent_closes_by_instrument(
            session, list(latest), on_or_before=today, limit=3
        )
        out: dict[str, Any] = {}
        for iid, (price, ccy) in latest.items():
            prev = [c for d, c in sorted(recent.get(iid, []), reverse=True) if d < today]
            out[str(iid)] = {
                "px": format(price, "f"),
                "ccy": ccy,
                "prev_close": format(prev[0], "f") if prev else None,
            }
        return out
    except Exception:
        log.warning("tick prices unavailable", exc_info=True)
        return None


def _tick_point(session: Any, total_eur: Decimal, rate: Decimal | None) -> dict[str, Any] | None:
    """The intraday sample this tick just stored, as a graph point (or ``None``).

    ``USD`` is the total at the sample's own stored FX (single instant); ``EUR`` is
    that USD value divided by the same rate, i.e. the total itself.
    """
    try:
        from investment_dashboard.services import (  # noqa: PLC0415
            intraday_snapshots_service,
            live_state,
        )

        series = intraday_snapshots_service.day_series_with_fx(session)
        if not series:
            return None
        at, _market, fx = series[-1]
        t = at.replace(tzinfo=UTC).isoformat()
        if t == live_state.last_point_t():
            return None  # no new sample this tick (market closed / dedupe floor)
        fx = fx or rate
        if fx is None or fx == 0:
            return {"t": t, "EUR": _dec(total_eur), "USD": None}
        usd = total_eur * fx
        return {"t": t, "EUR": _dec(usd / fx), "USD": _dec(usd)}
    except Exception:
        log.warning("tick point unavailable", exc_info=True)
        return None


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
        # Live spot first: this job also stamps ``last_fx``, so the live EUR/USD
        # must really be fetched here (a restart otherwise sat on the ECB
        # end-of-day rate until the next FX run).
        boot._refresh_live_fx,
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

    minutes = settings_service.get_or("scheduler.fx_interval_minutes", None)
    return FX_INTERVAL if minutes is None else timedelta(minutes=int(minutes))


def default_closed_interval() -> timedelta:
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    minutes = settings_service.get_or("scheduler.closed_interval_minutes", None)
    return CLOSED_INTERVAL if minutes is None else timedelta(minutes=int(minutes))


def default_fx_closed_interval() -> timedelta:
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    minutes = settings_service.get_or("scheduler.fx_closed_interval_minutes", None)
    return CLOSED_INTERVAL if minutes is None else timedelta(minutes=int(minutes))


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
    #: Price checks while the US stock market is closed.
    closed_interval: Callable[[], timedelta] = default_closed_interval
    #: FX checks while the currency market is closed (weekends).
    fx_closed_interval: Callable[[], timedelta] = default_fx_closed_interval
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
    #: What the last published tick / fx event carried (change detection).
    last_payload: dict[str, Any] = field(default_factory=dict)


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
        stocks = self._due_stocks(now, interval_seconds)
        if stocks == ["eod"]:
            return stocks  # eod refreshes the FX rate as well
        return [*stocks, *self._due_fx(now)]

    def _due_stocks(self, now: datetime, interval_seconds: int) -> list[str]:
        """The stock clock: live interval while the US market is open, else eod + closed."""
        st = self.state
        if market_hours.is_us_market_open(now):
            every = timedelta(seconds=interval_seconds)
        elif st.last_eod_session != market_hours.latest_settled_session_date(now):
            return ["eod"]
        else:
            every = self._interval(self.jobs.closed_interval, CLOSED_INTERVAL)
        return ["tick"] if st.last_tick is None or now - st.last_tick >= every else []

    def _due_fx(self, now: datetime) -> list[str]:
        """The currency clock (24/5), independent of the stock market."""
        st = self.state
        if market_hours.is_forex_market_open(now):
            every = self._interval(self.jobs.fx_interval, FX_INTERVAL)
        else:
            every = self._interval(self.jobs.fx_closed_interval, CLOSED_INTERVAL)
        return ["fx"] if st.last_fx is None or now - st.last_fx >= every else []

    @staticmethod
    def _interval(read: Callable[[], timedelta], fallback: timedelta) -> timedelta:
        try:
            return read()
        except Exception:
            return fallback

    def _unchanged(self, etype: str, extra: dict[str, Any] | None) -> bool:
        """True when a tick / fx check carries exactly what the last one did."""
        if etype not in ("tick", "fx") or not extra or extra.get("point") is not None:
            return False
        payload = {k: extra.get(k) for k in _CHANGE_KEYS}
        before = self.state.last_payload.get(etype)
        self.state.last_payload[etype] = payload
        return before == payload

    # -- execution ---------------------------------------------------------

    def _stamp(self, name: str, now: datetime) -> None:
        """Record when each clock last ran (stocks: tick/eod, currencies: fx/eod)."""
        st = self.state
        if name == "tick":
            st.last_tick = now
        elif name == "fx":
            st.last_fx = now
        elif name == "eod":
            # It pulled the closes and the live spot: both clocks start over.
            st.last_eod_session = market_hours.latest_settled_session_date(now)
            st.last_fx = now
            st.last_tick = now
        elif name == "backup":
            st.last_backup = now

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
            self._stamp(name, now)
            if failed or name == "backup":
                return
            etype = {"tick": "tick", "fx": "fx", "eod": "refresh"}[name]
            event: live_bus.Event = {
                "type": etype,
                "ts": _event_ts(self.clock()),
                "market_state": live_bus.market_state(now),
            }
            event.update(extra or {})
            unchanged = self._unchanged(etype, extra)
            if unchanged:
                event["unchanged"] = True
            if etype == "tick":
                live_state.record_tick(event, day=market_hours.exchange_today(now))
            self.bus.publish(event)
            if etype in ("tick", "fx") and not unchanged and self.bus.subscriber_count > 0:
                # Pre-compute the reads the clients refetch right after a tick (in the
                # background: the tick job is already done).
                with contextlib.suppress(Exception):
                    threading.Thread(
                        target=read_cache.warm, name="inv-dashboard-cache-warm", daemon=True
                    ).start()
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
