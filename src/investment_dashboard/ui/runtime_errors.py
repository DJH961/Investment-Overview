"""Live in-app surfacing of background-task failures.

The launcher now runs the app with no console window, so a background failure
that only reaches ``log.warning`` is invisible. :mod:`services.runtime_status`
records those failures; this module makes *new* ones visible while you use the
app by popping a dismissable toast.

A per-page :func:`nicegui.ui.timer` polls :func:`services.runtime_status.sequence`
and notifies when it advances. The "seen" counter is seeded with the current
sequence when the page loads, so only errors that occur *during* this page's
lifetime toast — historical errors stay available (without nagging) on the Data
Health page. :func:`install_client_watch` is called once per page from
:func:`investment_dashboard.ui.layout.page_frame`.
"""

from __future__ import annotations

#: How often each client checks for new background errors. Cheap (an in-memory
#: counter read), so a short interval keeps the toast feeling immediate without
#: meaningful cost; kept at 5s to avoid redundant work on idle pages.
POLL_INTERVAL_SECONDS = 5.0

#: How long the error toast stays up (ms) before auto-dismissing — long enough
#: to read and act on, short enough not to linger; it is also manually
#: dismissable via its close button.
TOAST_TIMEOUT_MS = 8000


def install_client_watch() -> None:
    """Register a per-client timer that toasts new background failures."""
    from nicegui import ui  # noqa: PLC0415 - needs a NiceGUI page context

    from investment_dashboard.services import runtime_status  # noqa: PLC0415

    # Seed with the current count so pre-existing errors don't re-toast on every
    # navigation; only failures after this page loads are announced.
    state = {"seen": runtime_status.sequence()}

    def _poll() -> None:
        current = runtime_status.sequence()
        if current <= state["seen"]:
            # Clamp (e.g. after a reset) so we never miss future increments.
            state["seen"] = current
            return
        state["seen"] = current
        latest = runtime_status.latest()
        if latest is None:
            return
        ui.notify(
            f"{latest.source} failed — see Data Health for details.",
            type="negative",
            position="top",
            timeout=TOAST_TIMEOUT_MS,
            close_button="Dismiss",
        )

    ui.timer(POLL_INTERVAL_SECONDS, _poll)
