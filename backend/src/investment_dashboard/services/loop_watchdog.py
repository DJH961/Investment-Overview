"""Event-loop stall watchdog — a heads-up when a calculation blocks the UI.

NiceGUI/uvicorn serve the whole desktop app from a single asyncio event loop.
Any long *synchronous* calculation (a heavy metrics build, an expensive query,
an accidental O(n²) loop) runs **on** that loop, so while it churns the server
cannot answer the websocket heartbeat. Every connected tab then looks
disconnected at once and a reconnect/reload storm follows — the "one too-long
calculation and EVERYTHING breaks" symptom.

The durable fix is to move heavy work off the loop (see
:func:`investment_dashboard.ui.components.deferred.deferred`'s ``compute``
hook). This module is the *safety net*: a lightweight background task measures
how late the loop services a periodic wake-up and, when that lag crosses a
threshold, records a single heads-up (surfaced in-app via the Data Health page /
toast and written to the log). It cannot interrupt the blocking work — Python
doesn't allow that cleanly — but it turns an invisible freeze into an explicit,
actionable signal ("the UI was unresponsive for ~4s while something heavy ran"),
which is exactly the feedback the app was missing.

The watchdog is deliberately cheap (one ``asyncio.sleep`` per poll) and
self-throttling so a sustained stall reports at most once per cooldown rather
than spamming. :func:`install` wires it to NiceGUI's startup so it runs for the
life of the process.
"""

from __future__ import annotations

import asyncio
import logging
import time

log = logging.getLogger(__name__)

#: How often the watchdog wakes to measure loop responsiveness. Frequent enough
#: to catch a multi-second stall promptly, cheap enough to be free on idle.
DEFAULT_POLL_INTERVAL_SECONDS = 0.5

#: Lag (seconds beyond the scheduled wake) that counts as a stall worth
#: reporting. Comfortably above normal scheduling jitter so routine ticks never
#: cry wolf, low enough to catch the freezes users actually notice.
DEFAULT_STALL_THRESHOLD_SECONDS = 3.0

#: Minimum gap between reports. A long block trips many consecutive polls; this
#: collapses the burst into a single heads-up per incident-ish window.
DEFAULT_REPORT_COOLDOWN_SECONDS = 30.0

#: Fraction of a measured lag that must have been spent burning CPU for the lag
#: to count as a *real* on-loop stall rather than a suspend/deschedule. A
#: genuine blocking calculation keeps a core busy for ~the whole lag (fraction
#: near 1.0); when the OS deschedules or suspends the process — the app was
#: backgrounded while the user worked elsewhere, or the laptop slept — the wake
#: simply arrives late while almost no CPU was used (fraction near 0). Half is a
#: wide margin: real stalls clear it comfortably, idle-while-away ones don't.
DEFAULT_MIN_CPU_FRACTION = 0.5

#: Source label used for the in-app/Data Health entry.
STALL_SOURCE = "UI responsiveness"


def is_stall(lag_seconds: float, threshold_seconds: float) -> bool:
    """True when an observed loop ``lag`` qualifies as a reportable stall."""
    return lag_seconds >= threshold_seconds


def is_cpu_bound_stall(
    lag_seconds: float,
    cpu_used_seconds: float,
    *,
    min_cpu_fraction: float = DEFAULT_MIN_CPU_FRACTION,
) -> bool:
    """Whether a measured ``lag`` reflects real on-CPU work vs. a suspend/deschedule.

    During a genuine in-loop block the process keeps a core busy, so the CPU
    time consumed across the lag window tracks the lag. When the OS deschedules
    or suspends the process (the app was backgrounded while the user worked in
    other windows, or the machine slept), the wake just arrives late while the
    process burned almost no CPU. Requiring the CPU spent to be at least
    ``min_cpu_fraction`` of the lag screens out those wall-clock-only stalls so
    the watchdog stops crying wolf every time the user tabs away and back.
    """
    if lag_seconds <= 0:
        return False
    return cpu_used_seconds >= lag_seconds * min_cpu_fraction


def stall_message(lag_seconds: float) -> str:
    """Human-readable heads-up for a measured stall."""
    return (
        f"The interface was unresponsive for ~{lag_seconds:.1f}s while a long "
        "calculation ran on the server. Heavy work should run off the event "
        "loop (deferred compute) so this doesn't disconnect the app."
    )


class _Throttle:
    """Allow an event at most once per ``cooldown`` seconds (monotonic clock)."""

    def __init__(self, cooldown_seconds: float) -> None:
        self._cooldown = cooldown_seconds
        self._last: float | None = None

    def allow(self, now: float) -> bool:
        if self._last is not None and (now - self._last) < self._cooldown:
            return False
        self._last = now
        return True


def _report_stall(lag_seconds: float) -> None:
    """Log the stall (which also surfaces it in-app via the logging handler)."""
    # A plain ``warning`` is enough: the logging handler in
    # :mod:`investment_dashboard.logging` mirrors WARNING/ERROR records into
    # ``runtime_status`` (toast + Data Health), so we must NOT also call
    # ``record_error`` or it would be reported twice.
    log.warning("%s: %s", STALL_SOURCE, stall_message(lag_seconds))


async def _run(
    *,
    poll_interval_seconds: float,
    stall_threshold_seconds: float,
    report_cooldown_seconds: float,
) -> None:  # pragma: no cover - timing loop driven by the live event loop
    """Measure loop lag forever, reporting stalls (throttled). Never raises out."""
    loop = asyncio.get_running_loop()
    throttle = _Throttle(report_cooldown_seconds)
    while True:
        scheduled = loop.time()
        cpu_before = time.process_time()
        try:
            await asyncio.sleep(poll_interval_seconds)
        except asyncio.CancelledError:  # graceful shutdown
            return
        # If the loop was blocked, this wake arrives late; the overshoot beyond
        # the requested sleep is the time the loop spent unable to service us.
        lag = loop.time() - scheduled - poll_interval_seconds
        # ...and the CPU the process burned over that same window tells a real
        # blocking calculation (CPU ~= lag) apart from a suspend/deschedule
        # while the user was away (CPU ~= 0) — only the former is worth a report.
        cpu_used = time.process_time() - cpu_before
        if (
            is_stall(lag, stall_threshold_seconds)
            and is_cpu_bound_stall(lag, cpu_used)
            and throttle.allow(loop.time())
        ):
            try:
                _report_stall(lag)
            except Exception:  # never let the safety net take the app down
                log.debug("failed to report event loop stall", exc_info=True)


def start(
    *,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    stall_threshold_seconds: float = DEFAULT_STALL_THRESHOLD_SECONDS,
    report_cooldown_seconds: float = DEFAULT_REPORT_COOLDOWN_SECONDS,
) -> asyncio.Task[None] | None:
    """Launch the watchdog on the running loop; return its task (or ``None``).

    Safe to call when no loop is running (it no-ops and returns ``None``), so it
    can be wired into an ``app.on_startup`` hook without guarding the caller.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover - no running loop (e.g. at import)
        return None
    return loop.create_task(
        _run(
            poll_interval_seconds=poll_interval_seconds,
            stall_threshold_seconds=stall_threshold_seconds,
            report_cooldown_seconds=report_cooldown_seconds,
        ),
        name="inv-loop-watchdog",
    )


def install() -> None:
    """Register the watchdog to start with the NiceGUI app (idempotent enough).

    Mirrors :func:`investment_dashboard.services.error_reporting.install_asyncio_handler`:
    the work needs a running loop, so it is scheduled from an ``app.on_startup``
    hook rather than executed inline.
    """
    from nicegui import app  # noqa: PLC0415 - lazy (only needed when wiring the app)

    app.on_startup(start)
