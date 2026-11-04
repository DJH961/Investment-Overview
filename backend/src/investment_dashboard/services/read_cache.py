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
import hashlib
import logging
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from decimal import Decimal
from enum import Enum
from typing import Any

log = logging.getLogger(__name__)

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
#: (key, generations) -> Event set when the thread computing it finished (single flight).
_inflight: dict[tuple[Any, ...], threading.Event] = {}
#: Longest a waiter sits behind another thread's computation before computing itself.
_WAIT_SECONDS = 30.0
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
        while True:
            now = time.monotonic()
            with _lock:
                snap = tuple((d, _gens[d]) for d in deps)
                hit = _entries.get(key)
                if hit is not None and hit[0] == snap and hit[1] > now:
                    _entries.move_to_end(key)
                    return hit[2]  # type: ignore[no-any-return]
                flight = (key, snap)
                pending = _inflight.get(flight)
                if pending is None:
                    _inflight[flight] = done = threading.Event()
            if pending is None:
                break
            # Single flight: another thread computes this key at this generation.
            pending.wait(timeout=_WAIT_SECONDS)
            with _lock:
                if _inflight.get(flight) is pending:  # stuck: stop waiting, compute
                    pending = None
            if pending is None:
                done = threading.Event()
                break
        try:
            value = func(*args, **kwargs)
            with _lock:
                # Something it reads changed while computing: don't store a stale answer.
                if snap == tuple((d, _gens[d]) for d in deps):
                    _entries[key] = (snap, now + TTL_SECONDS, value)
                    _entries.move_to_end(key)
                    while len(_entries) > MAX_ENTRIES:
                        _entries.popitem(last=False)
            return value
        finally:
            with _lock:
                if _inflight.get(flight) is done:
                    del _inflight[flight]
            done.set()

    return wrapper


_warmers: list[Callable[[Any], None]] = []


def register_warmer(fn: Callable[[Any], None]) -> None:
    """Register ``fn(session)`` to pre-compute a read after a tick (see :func:`warm`)."""
    if fn not in _warmers:
        _warmers.append(fn)


def warm() -> None:
    """Compute the registered reads sequentially on one session; never raises.

    Each warmer calls the same cached function the API route uses, so the cache keys
    match. A failure is logged and the next warmer still runs.
    """
    if not _warmers:
        return
    started = time.perf_counter()
    try:
        from investment_dashboard.db import ledger_session_scope  # noqa: PLC0415

        with ledger_session_scope() as session:
            for fn in list(_warmers):
                try:
                    fn(session)
                except Exception:
                    log.warning("read cache warmer %s failed", fn, exc_info=True)
    except Exception:
        log.warning("read cache warm-up failed", exc_info=True)
    log.debug("read cache warmed in %.2fs", time.perf_counter() - started)


#: Changes on every process start so a restarted server (generations back at 0)
#: never matches an ETag a client got from the previous process.
_BOOT_NONCE = secrets.token_hex(4)


def generations(deps: tuple[str, ...] = ALL_DEPS) -> tuple[tuple[str, int], ...]:
    """Current generation counters of ``deps``."""
    with _lock:
        return tuple((d, _gens[d]) for d in deps)


def conditional_both[**P, R](route: str, *, deps: tuple[str, ...] = ALL_DEPS) -> Any:
    """Weak-ETag conditional GET for the ``/both`` routes.

    The ETag is built from the route name, its plain parameters and the generations
    of ``deps``. On a matching ``If-None-Match`` the wrapper answers 304 **without**
    calling the endpoint. The endpoint must take ``request: Request`` and
    ``response: Response`` (so the ETag header is set on a fresh answer); put this
    decorator outside :func:`cached_read`.
    """

    def decorate(func: Callable[P, R]) -> Callable[P, Any]:
        @functools.wraps(func)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> Any:
            from fastapi import Response  # noqa: PLC0415

            request = kwargs["request"]
            plain = sorted((k, str(v)) for k, v in kwargs.items() if isinstance(v, _KEYABLE))
            gens = ",".join(f"{d}={g}" for d, g in generations(deps))
            digest = hashlib.sha1(
                f"{_BOOT_NONCE}|{route}|{plain}|{gens}".encode(), usedforsecurity=False
            ).hexdigest()[:20]
            etag = f'W/"{digest}"'
            sent = request.headers.get("if-none-match", "")  # type: ignore[attr-defined]
            candidates = {c.strip() for c in sent.split(",")}
            if etag in candidates or "*" in candidates:
                return Response(status_code=304, headers={"ETag": etag})
            value = func(*args, **kwargs)
            kwargs["response"].headers["ETag"] = etag  # type: ignore[attr-defined]
            return value

        return wrapper

    return decorate


def size() -> int:
    """Number of cached answers (tests, diagnostics)."""
    with _lock:
        return len(_entries)
