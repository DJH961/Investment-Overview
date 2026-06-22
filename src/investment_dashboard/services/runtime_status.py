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


#: Severity levels a recorded event can carry. ``"warning"`` is for non-fatal
#: chatter (a single missing-data ``WARNING`` log line, a UI-responsiveness
#: stall) that the UI shows in amber rather than as a red error.
SEVERITY_WARNING = "warning"
SEVERITY_ERROR = "error"


@dataclass(frozen=True)
class BackgroundError:
    """One recorded background problem (a failure *or* a warning).

    ``severity`` is ``"error"`` for genuine failures and ``"warning"`` for
    non-fatal chatter (e.g. a single ``WARNING`` log line). The UI renders the
    two differently — red vs amber — instead of treating everything as an error.
    """

    source: str
    message: str
    seq: int
    at: datetime = field(default_factory=lambda: datetime.now(UTC))
    severity: str = SEVERITY_ERROR

    @property
    def is_warning(self) -> bool:
        """True when this event is a non-fatal warning rather than an error."""
        return self.severity == SEVERITY_WARNING


_lock = threading.Lock()
_log: deque[BackgroundError] = deque(maxlen=_MAX_LOG_ENTRIES)
#: Monotonic error counter, boxed in a dict so updates need no ``global``.
_state: dict[str, int] = {"seq": 0}
#: Last time each ``(source, message)`` was recorded, for de-duplication. Pruned
#: of expired entries on every call to :func:`record_error`, so it stays bounded
#: by the number of *distinct* recent failures.
_last_seen: dict[tuple[str, str], datetime] = {}


def record_error(source: str, message: str, *, severity: str = SEVERITY_ERROR) -> BackgroundError:
    """Store a background problem and return the resulting event.

    Thread-safe: background refreshes run on separate threads/tasks. ``seq`` is a
    monotonically increasing counter the UI uses to detect *new* errors without
    holding a reference to the event itself.

    ``severity`` is ``"error"`` (the default) for genuine failures or
    ``"warning"`` for non-fatal chatter; the UI styles the two differently.

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
            return BackgroundError(
                source=source, message=message, seq=_state["seq"], at=now, severity=severity
            )
        _last_seen[key] = now
        _state["seq"] += 1
        event = BackgroundError(
            source=source, message=message, seq=_state["seq"], at=now, severity=severity
        )
        _log.append(event)
    return event


def record_warning(source: str, message: str) -> BackgroundError:
    """Convenience wrapper for :func:`record_error` with ``severity="warning"``."""
    return record_error(source, message, severity=SEVERITY_WARNING)


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


def dismiss(seq: int) -> bool:
    """Remove a single recorded error by its ``seq``. Returns whether it existed.

    Lets the user clear an individual stale notification from the Data Health
    page once they've seen it. ``seq`` keeps advancing, so a dismissed error is
    gone for good (a genuinely *new* failure gets a fresh ``seq`` and reappears).
    """
    with _lock:
        for event in list(_log):
            if event.seq == seq:
                _log.remove(event)
                _last_seen.pop((event.source, event.message), None)
                return True
    return False


def dismiss_all() -> int:
    """Clear every recorded error (the "Dismiss all" action). Returns the count.

    Unlike :func:`reset`, the monotonic ``seq`` is preserved so the toast
    watcher doesn't replay old errors — only genuinely new failures advance it.
    """
    with _lock:
        count = len(_log)
        _log.clear()
        _last_seen.clear()
        return count


def resolve(source: str) -> int:
    """Drop retained errors from ``source`` because it has since succeeded.

    Called when a background task (e.g. the price/FX refresh) completes without
    error, so a notification that "prices are outdated" disappears on its own
    once a later refresh actually lands the prices — rather than lingering
    forever. Returns the number of errors cleared. ``seq`` is left untouched.
    """
    with _lock:
        keep = [e for e in _log if e.source != source]
        removed = len(_log) - len(keep)
        if removed:
            _log.clear()
            _log.extend(keep)
            for key in [k for k in _last_seen if k[0] == source]:
                del _last_seen[key]
        return removed
