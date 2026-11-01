"""``deferred`` — paint a spinner first, then build heavy content after the
first browser frame.

NiceGUI builds a page synchronously before sending it to the client, so a page
that crunches metrics/positions/projection up-front leaves the user staring at a
blank tab until everything is ready. ``deferred`` renders a lightweight spinner
immediately and schedules the expensive work on a one-shot timer, so the shell
paints first and the spinner is swapped for the real content the moment it is
ready.

It is also the app's defence against *rapid view switching*: when the user
clicks through Monthly -> Yearly -> Overview again and again, each page's heavy
work is scheduled **after** paint and is skipped entirely if the client has
already navigated away by the time the timer fires. That keeps a burst of clicks
from piling expensive database work onto tabs nobody is looking at anymore (the
"toggling breaks it every time" symptom).

**Keeping the server responsive.** The single biggest cause of the app "dying"
is a long synchronous calculation running on the asyncio event loop: while it
runs, NiceGUI cannot answer the websocket heartbeat, so *every* connected tab
looks disconnected and a reconnect/reload storm follows. Pass a ``compute``
callback to run that heavy, render-free work **off the event loop** on a worker
thread (via :func:`nicegui.run.io_bound`); its result is then handed to
``build`` back on the loop for the actual UI rendering. The loop stays free to
service heartbeats throughout, so one slow calculation no longer takes the whole
app down with it.

If the work fails (or the user navigates away mid-compute), the spinner is
replaced by a small error notice instead of spinning forever, and the failure is
logged so it surfaces on the Data Health page.

Usage::

    # Simple: build runs on the event loop (fine for light pages).
    deferred(lambda: _render_overview_body(value_range))

    # Resilient: heavy gathering runs off-thread, render stays on the loop.
    deferred(_render, compute=_gather_data)
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from nicegui import context, ui

log = logging.getLogger(__name__)


def deferred(
    build: Callable[..., None],
    *,
    compute: Callable[[], Any] | None = None,
    label: str = "Loading…",
    delay: float = 0.05,
) -> None:  # pragma: no cover - UI timing
    """Show a spinner, then run ``build`` once the page has painted.

    ``build`` renders the page body inside the same container the spinner
    occupied, so the spinner disappears as soon as the content is in place. If
    the client has navigated away before the timer fires, the heavy work is
    skipped so rapid view switching never stacks up work on tabs that are gone.

    When ``compute`` is given, it is run off the event loop on a worker thread
    and its result is passed to ``build`` (``build(result)``) back on the loop.
    Use it for any page whose data gathering is heavy enough to risk blocking
    the loop — keeping the websocket responsive avoids the "one slow calculation
    disconnects everything" failure. ``compute`` must not touch NiceGUI/UI
    elements (it runs off-thread); do all rendering in ``build``.
    """
    client = context.client
    container = ui.column().classes("w-full")
    with container, ui.row().classes("w-full items-center justify-center q-pa-xl gap-sm"):
        ui.spinner(size="lg")
        if label:
            ui.label(label).classes("text-caption opacity-70")

    def _render_error() -> None:
        container.clear()
        with container, ui.row().classes("w-full items-center justify-center q-pa-xl"):
            ui.label("Couldn't load this view — see Data Health for details.").classes(
                "text-caption text-negative"
            )

    if compute is None:

        def _run() -> None:
            # The user already clicked away — don't crunch metrics for a dead tab.
            if not client.has_socket_connection:
                return
            try:
                container.clear()
                with container:
                    build()
            except Exception:
                log.exception("deferred build failed")
                _render_error()

        ui.timer(delay, _run, once=True)
        return

    async def _run_async() -> None:
        if not client.has_socket_connection:
            return
        from nicegui import run  # noqa: PLC0415 - lazy (needs a NiceGUI context)

        try:
            # Heavy, render-free work runs on a worker thread so the event loop
            # stays free to answer websocket heartbeats while it churns.
            data = await run.io_bound(compute)
        except Exception:
            log.exception("deferred compute failed")
            if client.has_socket_connection:
                _render_error()
            return
        # The user may have navigated away while we computed — don't paint a
        # tab that is gone.
        if not client.has_socket_connection:
            return
        try:
            container.clear()
            with container:
                build(data)
        except Exception:
            log.exception("deferred build failed")
            _render_error()

    ui.timer(delay, _run_async, once=True)
