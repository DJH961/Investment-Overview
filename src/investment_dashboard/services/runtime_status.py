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

The store is process-local — restarts wipe it, which is fine because the next
refresh tick repopulates it within minutes.
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime

_MAX_LOG_ENTRIES = 50


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


def record_error(source: str, message: str) -> BackgroundError:
    """Store a background failure and return the resulting event.

    Thread-safe: background refreshes run on separate threads/tasks. ``seq`` is a
    monotonically increasing counter the UI uses to detect *new* errors without
    holding a reference to the event itself.
    """
    with _lock:
        _state["seq"] += 1
        event = BackgroundError(source=source, message=message, seq=_state["seq"])
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
