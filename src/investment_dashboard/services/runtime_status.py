"""In-memory tracker for background-task failures, surfaced in the UI.

The dashboard does slow/network work off the request path — the periodic live
price refresh (:func:`investment_dashboard.main._live_refresh_tick`) and the
post-boot deferred refresh (:func:`investment_dashboard.boot.run_deferred_network_refresh`).
Those failures were previously *only* written to the log via ``log.warning``,
which is invisible once the app runs with no console window.

This module records the most recent background failures in a tiny process-local
store so the UI can make them visible — both as a live toast (a per-page timer
polls :func:`sequence` and pops a ``ui.notify`` when it advances) and on the
Data Health page. It is the in-app counterpart to the launcher's native error
dialog: errors are reported *both* visually and in the logs.

It is no longer fed only by a couple of hand-wired background tasks: a logging
handler (:mod:`investment_dashboard.logging`) funnels every ``WARNING``/``ERROR``
log record here, and uncaught-exception hooks plus a ``stderr`` tee
(:mod:`investment_dashboard.services.error_reporting`) catch failures that never
go through ``logging`` at all. :func:`record_error` therefore de-duplicates a
repeated ``(source, message)`` within a short window so a chatty library cannot
spam the toast queue.

The store is process-local — restarts wipe it, which is fine because the next
refresh tick repopulates it within minutes.
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

#: Cap on retained errors. A handful is plenty for the UI's "recent failures"
#: view; older entries are evicted (the monotonic ``seq`` keeps counting).
_MAX_LOG_ENTRIES = 50

#: How long an identical ``(source, message)`` is suppressed after first being
#: recorded. Background ticks and noisy libraries tend to fail the *same* way
#: repeatedly; collapsing those within this window keeps the toast/list useful
#: instead of drowning it. Distinct messages are never suppressed.
_DEDUP_WINDOW = timedelta(seconds=30)


@dataclass(frozen=True)
class BackgroundError:
    """One failed background task."""

    source: str
    message: str
    seq: int
    at: datetime = field(default_factory=lambda: datetime.now(UTC))


_lock = threading.Lock()
_log: deque[BackgroundError] = deque(maxlen=_MAX_LOG_ENTRIES)
#: Monotonic error counter, boxed in a dict so updates need no ``global``.
_state: dict[str, int] = {"seq": 0}
#: Last time each ``(source, message)`` was recorded, for de-duplication. Pruned
#: of expired entries on every call so it stays bounded by the number of
#: *distinct* recent failures.
_last_seen: dict[tuple[str, str], datetime] = {}


def record_error(source: str, message: str) -> BackgroundError:
    """Store a background failure and return the resulting event.

    Thread-safe: background refreshes run on separate threads/tasks. ``seq`` is a
    monotonically increasing counter the UI uses to detect *new* errors without
    holding a reference to the event itself.

    An identical ``(source, message)`` seen again within :data:`_DEDUP_WINDOW` is
    suppressed: the previously recorded event is returned unchanged and ``seq``
    does **not** advance, so the toast watcher stays quiet. This keeps a
    repeatedly-failing background tick or a chatty library from flooding the UI.
    """
    with _lock:
        now = datetime.now(UTC)
        key = (source, message)
        # Prune expired dedup entries so the map can't grow without bound.
        for stale_key in [k for k, seen in _last_seen.items() if now - seen >= _DEDUP_WINDOW]:
            del _last_seen[stale_key]
        last = _last_seen.get(key)
        if last is not None and now - last < _DEDUP_WINDOW:
            _last_seen[key] = now
            # Return the matching retained event if it's still around; otherwise
            # synthesize one carrying the current counter (it was evicted).
            for event in reversed(_log):
                if event.source == source and event.message == message:
                    return event
            return BackgroundError(source=source, message=message, seq=_state["seq"], at=now)
        _last_seen[key] = now
        _state["seq"] += 1
        event = BackgroundError(source=source, message=message, seq=_state["seq"], at=now)
        _log.append(event)
    return event


def latest() -> BackgroundError | None:
    """Return the most recent background error, or ``None`` if there were none."""
    with _lock:
        return _log[-1] if _log else None


def recent(limit: int | None = None) -> list[BackgroundError]:
    """Return recent background errors, newest first, capped at ``limit``."""
    with _lock:
        events = list(_log)
    events.reverse()
    if limit is not None:
        events = events[:limit]
    return events


def sequence() -> int:
    """Return the current error counter (0 when nothing has failed yet)."""
    with _lock:
        return _state["seq"]


def reset() -> None:
    """Clear all recorded errors. Test-only helper."""
    with _lock:
        _log.clear()
        _state["seq"] = 0
        _last_seen.clear()
