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
* otherwise the live FX spot every 30 minutes (``fx`` event).

Clock, sleep, jobs and bus are injectable for tests.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from investment_dashboard.domain import market_hours
from investment_dashboard.services import live_bus

log = logging.getLogger(__name__)

POLL_SECONDS = 5.0
FX_INTERVAL = timedelta(minutes=30)

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


def default_interval() -> int:
    from investment_dashboard.db import config_session_scope  # noqa: PLC0415
    from investment_dashboard.services import auto_refresh  # noqa: PLC0415

    with config_session_scope() as session:
        return auto_refresh.get_interval_seconds(session)


@dataclass
class Jobs:
    tick: Job = default_tick_job
    fx: Job = default_fx_job
    eod: Job = default_eod_job
    interval_seconds: Callable[[], int] = default_interval


@dataclass
class State:
    last_tick: datetime | None = None
    last_fx: datetime | None = None
    last_eod_session: date | None = None
    running: set[str] = field(default_factory=set)


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

    # -- decisions ---------------------------------------------------------

    def due(self, now: datetime, interval_seconds: int = 60) -> list[str]:
        """Names of the jobs that should run at ``now`` (pure, no I/O)."""
        st = self.state
        if market_hours.is_us_market_open(now):
            if st.last_tick is None or now - st.last_tick >= timedelta(seconds=interval_seconds):
                return ["tick"]
            return []
        if st.last_eod_session != market_hours.latest_settled_session_date(now):
            return ["eod"]
        if st.last_fx is None or now - st.last_fx >= FX_INTERVAL:
            return ["fx"]
        return []

    # -- execution ---------------------------------------------------------

    async def _run_job(self, name: str, now: datetime) -> None:
        st = self.state
        if name in st.running:  # a job never overlaps itself
            return
        st.running.add(name)
        try:
            failed = False
            extra: dict[str, Any] | None = None
            try:
                extra = await asyncio.to_thread(getattr(self.jobs, name))
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("scheduler job %s failed", name, exc_info=True)
                failed = True
            # Mark done even on failure so a broken job retries at its normal
            # cadence instead of spinning every poll.
            if name == "tick":
                st.last_tick = now
            elif name == "fx":
                st.last_fx = now
            elif name == "eod":
                st.last_eod_session = market_hours.latest_settled_session_date(now)
                st.last_fx = now
            if failed:
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
        ran = self.due(now, interval)
        for name in ran:
            await self._run_job(name, now)
        return ran

    async def run(self) -> None:
        while True:
            try:
                await self.step()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("scheduler step failed")
            await self.sleep(self.poll_seconds)
