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

#: What a cached answer can depend on. Each has its own generation counter.
LEDGER = "ledger"
PRICES = "prices"
FX = "fx"
ALL_DEPS: tuple[str, ...] = (LEDGER, PRICES, FX)

_lock = threading.Lock()
#: key -> (generations of the dependencies it read, expiry, value)
_entries: OrderedDict[tuple[Any, ...], tuple[tuple[tuple[str, int], ...], float, Any]] = (
    OrderedDict()
)
#: Per-dependency generation; bumped by :func:`invalidate`. An answer computed
#: across a bump of a dependency it reads is not stored.
_gens: dict[str, int] = dict.fromkeys(ALL_DEPS, 0)
_KEYABLE = (str, int, float, bool, Decimal, Enum, type(None))


def invalidate(*deps: str) -> None:
    """Forget cached answers that read any of ``deps`` (default: every dependency).

    Writes bump ``LEDGER``; a live tick bumps ``PRICES`` and ``FX`` only, so an
    answer that declared it reads just the ledger survives it.
    """
    targets = deps or ALL_DEPS
    with _lock:
        for dep in targets:
            _gens[dep] += 1
        for key in [
            k for k, (snap, _, _) in _entries.items() if any(d in targets for d, _ in snap)
        ]:
            del _entries[key]


def invalidate_for_event(event_type: str) -> None:
    """Bump what a live event of ``event_type`` changed (see ``live_bus``)."""
    if event_type == "tick":
        invalidate(PRICES, FX)
    elif event_type == "fx":
        invalidate(FX)
    elif event_type == "graphs":
        invalidate(PRICES)
    else:  # refresh*, settings, job, unknown: be conservative (freshness caption etc.)
        invalidate()


def cached_read[**P, R](
    fn: Callable[P, R] | None = None, *, deps: tuple[str, ...] = ALL_DEPS
) -> Any:
    """Cache ``fn``'s result per call parameters until a dependency bump or the TTL.

    ``deps`` names what the answer reads (default: all); use it bare
    (``@cached_read``) or as ``@cached_read(deps=(LEDGER,))``.
    """
    if fn is None:
        return functools.partial(cached_read, deps=deps)
    name = f"{fn.__module__}.{fn.__qualname__}"
    func = fn

    @functools.wraps(func)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        key = (name, *sorted((k, v) for k, v in kwargs.items() if isinstance(v, _KEYABLE)))
        now = time.monotonic()
        with _lock:
            snap = tuple((d, _gens[d]) for d in deps)
            hit = _entries.get(key)
            if hit is not None and hit[0] == snap and hit[1] > now:
                _entries.move_to_end(key)
                return hit[2]  # type: ignore[no-any-return]
        value = func(*args, **kwargs)
        with _lock:
            # Something it reads changed while computing: don't store a stale answer.
            if snap == tuple((d, _gens[d]) for d in deps):
                _entries[key] = (snap, now + TTL_SECONDS, value)
                _entries.move_to_end(key)
                while len(_entries) > MAX_ENTRIES:
                    _entries.popitem(last=False)
        return value

    return wrapper


def size() -> int:
    """Number of cached answers (tests, diagnostics)."""
    with _lock:
        return len(_entries)
