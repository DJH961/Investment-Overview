"""Short-lived in-memory cache for the expensive read endpoints.

Every Overview, graph, holdings or periods request used to recompute from the
database (100 ms to several seconds on the encrypted server DB). Most of the
time nothing changed in between: the owner flips between pages and graph
ranges. This keeps the last result per endpoint + parameters for at most
:data:`TTL_SECONDS` and drops **everything** the moment data may have changed:

* any live event (price tick, FX update, end-of-day refresh, graph reload),
  via :func:`investment_dashboard.services.live_bus.LiveBus.publish`;
* any successful write request (``api/app.py`` middleware).

The decorator wraps the endpoint function itself, so FastAPI has already run
the router's ``require_auth`` dependency before a cached value is returned:
the cache never answers an unauthenticated request. Only plain parameter
values (``ccy``, ``range_key``, ``group_by``...) form the key; injected objects
such as the DB session are ignored.
"""

from __future__ import annotations

import functools
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from decimal import Decimal
from enum import Enum
from typing import Any

#: Upper bound on how old a cached answer can be, even without any event.
TTL_SECONDS = 60.0
#: Entries kept (LRU); a few KB to ~60 KB each.
MAX_ENTRIES = 64

_lock = threading.Lock()
_entries: OrderedDict[tuple[Any, ...], tuple[int, float, Any]] = OrderedDict()
#: Bumped by every invalidation; an answer computed across one is not stored.
_state = {"generation": 0}
_KEYABLE = (str, int, float, bool, Decimal, Enum, type(None))


def invalidate() -> None:
    """Forget every cached answer (data may have changed)."""
    with _lock:
        _state["generation"] += 1
        _entries.clear()


def cached_read[**P, R](fn: Callable[P, R]) -> Callable[P, R]:
    """Cache ``fn``'s result per call parameters until :func:`invalidate` or the TTL."""
    name = f"{fn.__module__}.{fn.__qualname__}"

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        key = (name, *sorted((k, v) for k, v in kwargs.items() if isinstance(v, _KEYABLE)))
        now = time.monotonic()
        with _lock:
            gen = _state["generation"]
            hit = _entries.get(key)
            if hit is not None and hit[0] == gen and hit[1] > now:
                _entries.move_to_end(key)
                return hit[2]  # type: ignore[no-any-return]
        value = fn(*args, **kwargs)
        with _lock:
            # Something changed while computing: don't store a possibly stale answer.
            if gen == _state["generation"]:
                _entries[key] = (gen, now + TTL_SECONDS, value)
                _entries.move_to_end(key)
                while len(_entries) > MAX_ENTRIES:
                    _entries.popitem(last=False)
        return value

    return wrapper


def size() -> int:
    """Number of cached answers (tests, diagnostics)."""
    with _lock:
        return len(_entries)
