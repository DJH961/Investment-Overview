"""In-process pub/sub for live events (v6 server; feeds ``GET /api/stream``).

Every subscriber owns a bounded :class:`asyncio.Queue`; when it is full the
*oldest* event is dropped so a slow client never blocks the publisher.
:meth:`LiveBus.publish` is thread-safe: scheduler jobs run in worker threads
and hand events to each subscriber's event loop with ``call_soon_threadsafe``.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from datetime import UTC, datetime
from typing import Any

from investment_dashboard.domain import market_hours

log = logging.getLogger(__name__)

DEFAULT_QUEUE_SIZE = 64

Event = dict[str, Any]


def market_state(now: datetime | None = None) -> str:
    """``"open"`` | ``"holiday"`` | ``"closed"`` for the NYSE at ``now`` (UTC)."""
    now = now or datetime.now(UTC)
    if market_hours.is_us_market_open(now):
        return "open"
    local_day = market_hours.exchange_today(now)
    if local_day.weekday() < 5 and market_hours.is_us_market_holiday(local_day):
        return "holiday"
    return "closed"


class Subscription:
    """One subscriber's bounded queue, bound to the loop that created it."""

    def __init__(self, bus: LiveBus, maxsize: int) -> None:
        self._bus = bus
        self.queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=maxsize)
        self.loop = asyncio.get_running_loop()
        self.dropped = 0

    def _put(self, event: Event) -> None:
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
                self.dropped += 1
        with contextlib.suppress(asyncio.QueueFull):
            self.queue.put_nowait(event)

    async def get(self) -> Event:
        return await self.queue.get()

    def close(self) -> None:
        self._bus.unsubscribe(self)

    def __enter__(self) -> Subscription:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class LiveBus:
    def __init__(self, *, queue_size: int = DEFAULT_QUEUE_SIZE) -> None:
        self._queue_size = queue_size
        self._subs: list[Subscription] = []
        self._lock = threading.Lock()

    def subscribe(self) -> Subscription:
        """Register a subscriber. Must be called from a running event loop."""
        sub = Subscription(self, self._queue_size)
        with self._lock:
            self._subs.append(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            if sub in self._subs:
                self._subs.remove(sub)

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subs)

    def publish(self, event: Event) -> None:
        """Fan ``event`` out to every subscriber; safe from any thread."""
        with self._lock:
            subs = list(self._subs)
        for sub in subs:
            try:
                sub.loop.call_soon_threadsafe(sub._put, event)
            except RuntimeError:  # that loop is closed: subscriber is gone
                self.unsubscribe(sub)


#: The process-wide bus used by the scheduler and ``/api/stream``.
bus = LiveBus()
