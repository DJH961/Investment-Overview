"""In-memory tracker for *automatic* price-refresh activity, surfaced in the UI.

The local app pulls fresh market data on its own in two places that the user
never explicitly triggers:

* the post-boot deferred refresh
  (:func:`investment_dashboard.boot.run_deferred_network_refresh`), and
* the periodic live-price tick
  (:func:`investment_dashboard.main._live_refresh_tick`).

Both run off the request path (a background daemon thread / a server-side
``app.timer``), so without a cue the user has no way to tell the automatic
features are working at all. This module records a tiny, process-local view of
that activity — whether a refresh is *running right now* and when one last
brought in new data — so the header can show a live "Auto-updating…" chip (a
per-page timer polls :func:`snapshot` and reflects it). It is the read-only,
"things are working" counterpart to :mod:`investment_dashboard.services.runtime_status`
(which surfaces the *failures*).

The store is process-local — restarts wipe it, which is fine because the next
refresh tick repopulates it within a minute.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import UTC, datetime


@dataclass(frozen=True)
class RefreshActivity:
    """An immutable snapshot of the automatic-refresh state.

    ``seq`` is a monotonically increasing counter the UI uses to detect a change
    cheaply (it advances on every :func:`begin`/:func:`finish`), so a poller can
    skip redrawing when nothing has moved.
    """

    active: bool
    source: str | None
    seq: int
    last_update_at: datetime | None


_lock = threading.Lock()
#: ``depth`` counts concurrently-running automatic refreshes so overlapping
#: tasks (the startup refresh and a live tick) don't prematurely clear "active".
_state: dict[str, object] = {
    "depth": 0,
    "source": None,
    "seq": 0,
    "last_update_at": None,
}


def begin(source: str) -> None:
    """Mark an automatic refresh as started (the chip shows "Updating…").

    Thread-safe: refreshes run on separate threads/tasks. Pair every call with
    :func:`finish` (use ``try/finally``) so the active state is always cleared.
    """
    with _lock:
        _state["depth"] = int(_state["depth"]) + 1
        _state["source"] = source
        _state["seq"] = int(_state["seq"]) + 1


def finish(source: str, *, updated: bool) -> None:
    """Mark an automatic refresh as finished.

    ``updated`` records whether the refresh actually brought in new data; when
    ``True`` the "last update" timestamp advances so the chip can reassure the
    user that fresh prices landed (a tick that found nothing due leaves it).
    """
    with _lock:
        _state["depth"] = max(0, int(_state["depth"]) - 1)
        if int(_state["depth"]) == 0:
            _state["source"] = None
        if updated:
            _state["last_update_at"] = datetime.now(UTC)
        _state["seq"] = int(_state["seq"]) + 1


def snapshot() -> RefreshActivity:
    """Return the current automatic-refresh state as an immutable snapshot."""
    with _lock:
        return RefreshActivity(
            active=int(_state["depth"]) > 0,
            source=_state["source"],  # type: ignore[arg-type]
            seq=int(_state["seq"]),
            last_update_at=_state["last_update_at"],  # type: ignore[arg-type]
        )


def sequence() -> int:
    """Return the current activity counter (advances on every state change)."""
    with _lock:
        return int(_state["seq"])


def reset() -> None:
    """Clear all recorded activity. Test-only helper."""
    with _lock:
        _state["depth"] = 0
        _state["source"] = None
        _state["seq"] = 0
        _state["last_update_at"] = None
