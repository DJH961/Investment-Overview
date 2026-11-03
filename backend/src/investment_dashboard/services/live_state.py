"""Process-wide live state: the tick sequence, the latest tick and today's points.

The scheduler records every ``tick`` event here (:func:`record_tick`, which stamps
the event's ``seq``); ``GET /api/live?since=N`` reads it (:func:`snapshot`) so a tab
that was hidden catches up with one small request. Pure memory, thread-safe, no DB
access. The points buffer holds the intraday samples of one trading day (capped)
and is emptied when the trading day changes.
"""

from __future__ import annotations

import copy
import threading
from collections import deque
from datetime import date
from typing import Any

#: Most intraday points kept (a session at one sample per minute is ~400).
MAX_POINTS = 600

_lock = threading.Lock()
_seq = 0
_latest: dict[str, Any] | None = None
_points: deque[tuple[int, dict[str, Any]]] = deque(maxlen=MAX_POINTS)
_day: date | None = None
_last_point_t: str | None = None


def reset() -> None:
    """Forget everything (tests)."""
    global _seq, _latest, _day, _last_point_t  # noqa: PLW0603
    with _lock:
        _seq = 0
        _latest = None
        _day = None
        _last_point_t = None
        _points.clear()


def current_seq() -> int:
    with _lock:
        return _seq


def last_point_t() -> str | None:
    """Timestamp of the newest recorded point (to avoid re-announcing a sample)."""
    with _lock:
        return _last_point_t


def record_tick(event: dict[str, Any], *, day: date | None = None) -> int:
    """Assign the next ``seq`` to ``event`` (in place) and remember it.

    ``day`` is the trading day of the tick; when it differs from the previous
    one the points buffer starts over. A ``point`` in the event is buffered.
    """
    global _seq, _latest, _day, _last_point_t  # noqa: PLW0603
    with _lock:
        if day is not None and day != _day:
            _points.clear()
            _last_point_t = None
            _day = day
        _seq += 1
        event["seq"] = _seq
        point = event.get("point")
        if isinstance(point, dict):
            _points.append((_seq, copy.deepcopy(point)))
            _last_point_t = str(point.get("t"))
        _latest = copy.deepcopy(event)
        return _seq


def snapshot(since: int = 0) -> tuple[int, dict[str, Any] | None, list[dict[str, Any]]]:
    """``(seq, latest tick, points with seq > since)``; points oldest first."""
    with _lock:
        points = [copy.deepcopy(p) for s, p in _points if s > since]
        return _seq, copy.deepcopy(_latest), points
