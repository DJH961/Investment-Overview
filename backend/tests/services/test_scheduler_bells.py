"""7.3.1 bell moments: a short close grace, session events, the quiet re-pull."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from .test_scheduler import Rig, et

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _states(sub: Any) -> list[str]:
    return [e["state"] for e in list(sub.queue._queue) if e.get("type") == "market_session"]


async def test_close_grace_then_eod_then_closed() -> None:
    r = Rig(et(2026, 11, 2, 15, 59))  # Monday, one minute before the bell
    r.sched.jobs.eod_grace = lambda: timedelta(seconds=60)
    sub = r.bus.subscribe()
    assert await r.sched.step() == ["tick"]
    assert _states(sub)[-1] == "open"
    r.now = et(2026, 11, 2, 16, 0) + timedelta(seconds=20)
    assert "eod" not in await r.sched.step()  # the official closes are still coming in
    assert _states(sub)[-1] == "closing"
    r.now = et(2026, 11, 2, 16, 1) + timedelta(seconds=5)
    assert "eod" in await r.sched.step()
    assert _states(sub)[-1] == "closed"
    assert _states(sub) == ["open", "closing", "closed"]  # each state once


async def test_open_bell_is_opening_until_the_first_tick() -> None:
    r = Rig(et(2026, 11, 2, 9, 29))
    r.sched.state.last_eod_session = None
    sub = r.bus.subscribe()
    r.sched.state.session_state = "closed"
    r.fail.add("tick")
    r.now = et(2026, 11, 2, 9, 30)
    await r.sched.step()
    assert _states(sub)[-1] == "opening"  # the first tick failed: not live yet
    r.fail.clear()
    r.now += timedelta(minutes=1)
    await r.sched.step()
    assert _states(sub)[-1] == "open"


async def test_quiet_repull_once_after_the_close() -> None:
    r = Rig(et(2026, 11, 2, 16, 30))
    pulls: list[int] = []
    r.sched.jobs.close_repull_delay = lambda: timedelta(minutes=5)
    r.sched.jobs.close_repull = lambda: pulls.append(1) is None
    assert await r.sched.repull_step() is False  # eod not done yet
    await r.sched.step()  # eod
    assert await r.sched.repull_step() is True
    assert await r.sched.repull_step() is False  # once per session
    assert pulls == [1]


async def test_repull_off_when_disabled() -> None:
    r = Rig(et(2026, 11, 2, 16, 30))
    r.sched.jobs.close_repull_delay = lambda: None
    await r.sched.step()
    assert await r.sched.repull_step() is False
