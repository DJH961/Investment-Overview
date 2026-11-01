from __future__ import annotations

import asyncio
import threading

import pytest

from investment_dashboard.services.live_bus import LiveBus

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def test_fan_out_to_all_subscribers() -> None:
    bus = LiveBus()
    a, b = bus.subscribe(), bus.subscribe()
    bus.publish({"type": "tick", "n": 1})
    assert (await asyncio.wait_for(a.get(), 1))["n"] == 1
    assert (await asyncio.wait_for(b.get(), 1))["n"] == 1
    a.close()
    assert bus.subscriber_count == 1
    b.close()
    assert bus.subscriber_count == 0


async def test_overflow_drops_oldest() -> None:
    bus = LiveBus(queue_size=2)
    sub = bus.subscribe()
    for n in range(4):
        bus.publish({"n": n})
    await asyncio.sleep(0.05)
    got = [(await sub.get())["n"], (await sub.get())["n"]]
    assert got == [2, 3]
    assert sub.dropped == 2


async def test_publish_from_worker_thread() -> None:
    bus = LiveBus()
    sub = bus.subscribe()
    t = threading.Thread(target=lambda: bus.publish({"type": "fx"}))
    t.start()
    assert (await asyncio.wait_for(sub.get(), 1))["type"] == "fx"
    t.join()
