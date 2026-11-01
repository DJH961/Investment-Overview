from __future__ import annotations

import asyncio
import threading
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from investment_dashboard.services.live_bus import LiveBus
from investment_dashboard.services.scheduler import Jobs, Scheduler

ET = ZoneInfo("America/New_York")

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def et(y: int, m: int, d: int, h: int, mi: int = 0) -> datetime:
    return datetime(y, m, d, h, mi, tzinfo=ET).astimezone(UTC)


class Rig:
    def __init__(self, now: datetime) -> None:
        self.now = now
        self.calls: list[str] = []
        self.bus = LiveBus()
        self.fail: set[str] = set()

        def make(name: str) -> Any:
            def job() -> dict[str, Any] | None:
                self.calls.append(name)
                if name in self.fail:
                    raise RuntimeError("boom")
                return {"x": name}

            return job

        self.sched = Scheduler(
            jobs=Jobs(
                tick=make("tick"),
                fx=make("fx"),
                eod=make("eod"),
                interval_seconds=lambda: 60,
            ),
            clock=lambda: self.now,
            bus=self.bus,
        )


async def test_market_open_ticks_every_interval() -> None:
    r = Rig(et(2026, 11, 2, 10))  # Monday
    assert await r.sched.step() == ["tick"]
    r.now += timedelta(seconds=30)
    assert await r.sched.step() == []
    r.now += timedelta(seconds=31)
    assert await r.sched.step() == ["tick"]
    assert r.calls == ["tick", "tick"]


async def test_after_close_runs_eod_once_then_fx() -> None:
    r = Rig(et(2026, 11, 2, 16, 30))
    sub = r.bus.subscribe()
    assert await r.sched.step() == ["eod"]
    ev = await asyncio.wait_for(sub.get(), 1)
    assert ev["type"] == "refresh"
    assert ev["market_state"] == "closed"
    assert await r.sched.step() == []  # eod done, fx stamped by eod
    r.now += timedelta(minutes=31)
    assert await r.sched.step() == ["fx"]
    assert (await asyncio.wait_for(sub.get(), 1))["type"] == "fx"


async def test_holiday_and_weekend_only_eod_once() -> None:
    for when in (et(2026, 11, 26, 11), et(2026, 11, 7, 11)):  # Thanksgiving, Saturday
        r = Rig(when)
        assert await r.sched.step() == ["eod"]
        assert await r.sched.step() == []
        assert "tick" not in r.calls


async def test_holiday_market_state() -> None:
    r = Rig(et(2026, 11, 26, 11))
    sub = r.bus.subscribe()
    await r.sched.step()
    assert (await asyncio.wait_for(sub.get(), 1))["market_state"] == "holiday"


async def test_new_session_triggers_eod_again() -> None:
    r = Rig(et(2026, 11, 2, 17))
    await r.sched.step()
    r.now = et(2026, 11, 3, 17)
    assert await r.sched.step() == ["eod"]


async def test_error_resilience_and_no_event_on_failure() -> None:
    r = Rig(et(2026, 11, 2, 10))
    r.fail.add("tick")
    sub = r.bus.subscribe()
    assert await r.sched.step() == ["tick"]
    assert sub.queue.empty()
    r.fail.clear()
    r.now += timedelta(seconds=61)
    await r.sched.step()
    assert (await asyncio.wait_for(sub.get(), 1))["type"] == "tick"


async def test_run_loop_survives_step_errors() -> None:
    r = Rig(et(2026, 11, 2, 10))
    n = 0

    async def sleep(_s: float) -> None:
        nonlocal n
        n += 1
        if n >= 3:
            raise asyncio.CancelledError
        await asyncio.sleep(0)

    boom = {"on": True}
    orig = r.sched.step

    async def step() -> list[str]:
        if boom["on"]:
            boom["on"] = False
            raise RuntimeError("x")
        return await orig()

    r.sched.step = step  # type: ignore[method-assign]
    r.sched.sleep = sleep
    with pytest.raises(asyncio.CancelledError):
        await r.sched.run()
    assert r.calls == ["tick"]


async def test_job_never_overlaps_itself() -> None:
    r = Rig(et(2026, 11, 2, 10))
    gate = threading.Event()
    started = threading.Event()

    def slow() -> None:
        r.calls.append("tick")
        started.set()
        gate.wait(2)

    r.sched.jobs.tick = slow  # type: ignore[assignment]
    first = asyncio.create_task(r.sched._run_job("tick", r.now))
    await asyncio.to_thread(started.wait, 1)
    await r.sched._run_job("tick", r.now)  # skipped: still running
    gate.set()
    await first
    assert r.calls == ["tick"]
