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


def request_shutdown() -> None:
    """Release the writer lock and stop the server. Safe to call repeatedly."""
    if _state["shutting_down"]:
        return
    _state["shutting_down"] = True
    # Release eagerly so a waiting instance can acquire the lock even while the
    # server drains; the ``on_shutdown`` hook releases again (idempotent).
    boot.release_writer_lock()
    log.info("shutdown requested; stopping server")
    app.shutdown()


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
