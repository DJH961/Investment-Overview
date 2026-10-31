"""Clean server shutdown and single-writer-lock handoff.

The packaged desktop build runs the NiceGUI server with ``show=True`` and no
visible console, so a user who closes the browser tab has historically had no
way to stop the process — and the still-running server keeps the single-writer
lock (see :mod:`investment_dashboard.storage.lock`), blocking every other
instance until the machine is rebooted or the process is killed from Task
Manager.

This module gives three robust exits, all of which release the writer lock:

* ``app.on_shutdown`` always releases the lock when the server stops for *any*
  reason (Ctrl+C, :func:`request_shutdown`, OS signal). Releasing it eagerly
  there means a waiting instance can grab it the moment we exit.
* :func:`request_shutdown` — an explicit "quit" the UI can trigger: it releases
  the lock and tells the server to stop.
* :func:`release_writer_lock_for_handoff` — release the lock *without* stopping
  the server, so this instance drops to read-only and another instance (e.g.
  another device on the same synced ledger) can take over writes.

Optionally (``auto_shutdown``) the server stops itself a short grace period
after the last browser tab disconnects. The grace period absorbs the brief
disconnect/reconnect that in-app navigation causes, so only a genuine
tab/window close triggers shutdown.
"""

from __future__ import annotations

import asyncio
import logging

from nicegui import Client, app

from investment_dashboard import boot

log = logging.getLogger(__name__)

#: Seconds to wait after the last tab disconnects before shutting down.
#: Long enough to ride out in-app navigation (which disconnects the old
#: per-page client and connects a new one) but short enough to feel prompt.
#: Module-level so tests can shrink it.
GRACE_SECONDS = 8.0

#: Mutable module state (dict avoids ``global`` reassignment, matching the
#: pattern in :mod:`investment_dashboard.boot`).
_state: dict[str, bool] = {"auto_shutdown": False, "shutting_down": False}


def set_auto_shutdown(enabled: bool) -> None:
    """Enable/disable auto-shutdown when the last browser tab closes."""
    _state["auto_shutdown"] = enabled


def auto_shutdown_enabled() -> bool:
    """Return whether auto-shutdown-on-tab-close is currently armed."""
    return _state["auto_shutdown"]


def _connected_client_count() -> int:
    """Number of browser clients with a live socket connection."""
    return sum(1 for client in Client.instances.values() if client.has_socket_connection)


def request_shutdown(*, publish: bool = True) -> None:
    """Release the writer lock and stop the server. Safe to call repeatedly.

    ``publish`` republishes the live-web blob first (proposal §5.4, gated by
    Settings). The Settings "Shut down" button publishes itself so it can show
    the user the result, and passes ``publish=False`` here to avoid a double
    upload; the automatic paths (tab-close, OS signal) keep the default.
    """
    if _state["shutting_down"]:
        return
    _state["shutting_down"] = True
    # A pending debounced manual-edit publish is now moot — we publish the latest
    # state below (or the UI already did), so cancel it to avoid a late upload.
    _cancel_pending_edit_publish()
    # v3.0 §5.4: graceful close is an auto-publish trigger. Do this before
    # releasing the lock / stopping so the DB is still fully available. It is
    # best-effort and never raises, so a publish failure can't block shutdown.
    if publish:
        _publish_on_shutdown()
    # Release eagerly so a waiting instance can acquire the lock even while the
    # server drains; the ``on_shutdown`` hook releases again (idempotent).
    boot.release_writer_lock()
    log.info("shutdown requested; stopping server")
    app.shutdown()


def _cancel_pending_edit_publish() -> None:
    """Cancel any pending debounced manual-edit publish; never raises."""
    try:
        from investment_dashboard.services import auto_publish  # noqa: PLC0415

        auto_publish.cancel_pending_edit_publish()
    except Exception:  # pragma: no cover - defensive
        log.warning("could not cancel pending manual-edit publish", exc_info=False)


def _publish_on_shutdown() -> None:
    """Best-effort live-web republish on graceful close (gated by Settings)."""
    try:
        from investment_dashboard.services import auto_publish  # noqa: PLC0415

        auto_publish.publish_on_trigger(auto_publish.TRIGGER_SHUTDOWN)
    except Exception:  # pragma: no cover - defensive; publish_on_trigger swallows its own errors
        log.warning("auto-publish on shutdown failed", exc_info=False)


def begin_graceful_shutdown(*, delay: float = 0.8) -> None:
    """Run the full user-facing shutdown sequence from a NiceGUI page context.

    This is the one place every "quit" control (the header power button and the
    Settings → Server "Shut down" button) funnels through, so they behave
    identically. The key ordering goal is that the *click is acknowledged
    instantly* — before the (blocking) live-web upload runs — so the user never
    wonders whether their click registered:

    1. **Immediately** paint a full-screen "Shutting down…" overlay
       (``__invBeginShutdown``) and suppress the "connection lost —
       reconnecting…" banner. This happens first, while the event loop is still
       free, so the browser actually receives it before anything heavy runs.
    2. **Deferred** (on a one-shot timer so step 1 paints first): republish the
       live-web blob — gated by Settings — while the DB is still fully available,
       then surface the upload result. The overlay stays up the whole time.
    3. Swap the overlay to its final "App shut down — close this tab" frame
       (``__invFinishShutdown``), which never triggers a reconnect and offers a
       manual close if the auto-closer is refused by the browser.
    4. After a short grace (so the toast + final frame paint), release the writer
       lock and stop the server. We already published in step 2, so this passes
       ``publish=False`` to avoid a duplicate upload.
    """
    from nicegui import ui  # noqa: PLC0415 - needs a NiceGUI page context

    # Step 1: instant feedback. Paint the overlay and suppress the reconnect
    # banner *now*, before the blocking upload, so the click is acknowledged
    # immediately instead of appearing to do nothing while the upload runs.
    ui.run_javascript("if (window.__invBeginShutdown) window.__invBeginShutdown();")
    # Steps 2–4: defer the upload + stop to a one-shot timer so the overlay above
    # reaches the browser first (a synchronous upload would otherwise block the
    # event loop and the overlay would never paint until it finished).
    ui.timer(delay, lambda: _publish_then_stop(delay), once=True)


def _publish_then_stop(delay: float) -> None:
    """Upload the live-web blob, surface the result, then stop the server.

    Runs from the deferred timer armed by :func:`begin_graceful_shutdown`, so the
    full-screen "Shutting down…" overlay is already on screen. Keeping the upload
    here (rather than inline) is what lets that overlay paint before the blocking
    upload runs.
    """
    from nicegui import ui  # noqa: PLC0415 - needs a NiceGUI page context

    from investment_dashboard.services import auto_publish  # noqa: PLC0415

    # Publish while the DB is still fully available, and surface the result. The
    # overlay stays up until this notification (when publishing is configured).
    outcome = auto_publish.run_trigger(auto_publish.TRIGGER_SHUTDOWN)
    note = auto_publish.describe_outcome(outcome)
    if note is not None:
        ui.notify(note[0], type=note[1])
    # Swap the overlay to its final "shut down — close this tab" frame and try to
    # auto-close the tab. This frame never triggers a reconnect.
    ui.run_javascript("if (window.__invFinishShutdown) window.__invFinishShutdown();")
    # Let the toast + final frame paint, then stop the server (already published).
    ui.timer(delay, lambda: request_shutdown(publish=False), once=True)


def release_writer_lock_for_handoff() -> bool:
    """Hand the writer lock to another instance without stopping the server.

    The app keeps running but flips to read-only, so a second instance can
    immediately acquire the lock and become the writer. Returns ``True`` if a
    lock was actually released (``False`` when this instance was already
    read-only / held no lock).
    """
    released = boot.release_writer_lock()
    if released:
        log.info("writer lock handed off; this instance is now read-only")
    return released


async def _on_disconnect(*_: object) -> None:  # pragma: no cover - event loop glue
    """Shut down shortly after the last tab closes, if armed."""
    if not _state["auto_shutdown"]:
        return
    await asyncio.sleep(GRACE_SECONDS)
    if _state["auto_shutdown"] and _connected_client_count() == 0:
        log.info("no browser tabs remain connected; auto-shutting down")
        request_shutdown()


def install(*, auto_shutdown: bool) -> None:
    """Register shutdown handlers. Call once from :func:`main.run`.

    * Always releases the writer lock on server shutdown.
    * Arms auto-shutdown-on-tab-close when ``auto_shutdown`` is true.
    """
    set_auto_shutdown(auto_shutdown)
    app.on_shutdown(boot.release_writer_lock)
    app.on_disconnect(_on_disconnect)
