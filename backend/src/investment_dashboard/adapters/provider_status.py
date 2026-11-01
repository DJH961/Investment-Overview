"""In-memory status tracker for external data providers (yfinance, FX, …).

The dashboard's UI needs to surface "did the last call to yfinance / Frankfurter
actually work?" without spelunking through log files. Adapters record a tiny
:class:`StatusEvent` after every attempt; the settings page reads them back
via :func:`get_status` / :func:`get_log`.

The store is process-local — it lives only for the lifetime of the running
dashboard. That matches the user's request ("a status log so I'm aware"):
restarts wipe the history, which is fine because the next refresh tick will
repopulate it within minutes.
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

Status = Literal["ok", "partial", "error"]

_MAX_LOG_ENTRIES = 50


@dataclass(frozen=True)
class StatusEvent:
    """One attempt to talk to an external provider."""

    provider: str
    status: Status
    message: str
    at: datetime = field(default_factory=lambda: datetime.now(UTC))


_lock = threading.Lock()
_latest: dict[str, StatusEvent] = {}
_log: deque[StatusEvent] = deque(maxlen=_MAX_LOG_ENTRIES)


def record(provider: str, status: Status, message: str) -> StatusEvent:
    """Store the outcome of one provider call and return the resulting event.

    Thread-safe: the dashboard's background refresh runs in a separate task.
    """
    event = StatusEvent(provider=provider, status=status, message=message)
    with _lock:
        _latest[provider] = event
        _log.append(event)
    return event


def get_status(provider: str) -> StatusEvent | None:
    """Return the most recent event for ``provider`` (or ``None`` if never called)."""
    with _lock:
        return _latest.get(provider)


def all_latest() -> dict[str, StatusEvent]:
    """Return a snapshot ``{provider: latest_event}`` for every known provider."""
    with _lock:
        return dict(_latest)


def get_log(limit: int | None = None) -> list[StatusEvent]:
    """Return recent events, newest first, capped at ``limit`` entries."""
    with _lock:
        events = list(_log)
    events.reverse()
    if limit is not None:
        events = events[:limit]
    return events


def reset() -> None:
    """Clear all recorded status. Test-only helper."""
    with _lock:
        _latest.clear()
        _log.clear()
