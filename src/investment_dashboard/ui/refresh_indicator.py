"""Header chip that shows the app's *automatic* price-refresh activity.

The local app pulls fresh prices on its own (the post-boot deferred refresh and
the periodic live-price tick — see
:mod:`investment_dashboard.services.refresh_status`). Those run in the
background with no visible cue, so the user can't tell the automatic features
are working. This module renders a small "Live / Auto-updating…" chip into the
header: a per-page :func:`nicegui.ui.timer` polls
:func:`investment_dashboard.services.refresh_status.snapshot` and reflects it —
the icon spins and the label reads "Updating…" while a refresh runs, and it
falls back to "Live" (with the last-update time once one has landed) when idle.

It is the always-on, "things are working" counterpart to
:mod:`investment_dashboard.ui.runtime_errors`, which only speaks up on failure.
"""

from __future__ import annotations

from datetime import tzinfo

#: How often each client re-reads the refresh state. Cheap (an in-memory read),
#: so a short interval keeps the chip feeling live without meaningful cost.
POLL_INTERVAL_SECONDS = 1.5


def install_header_indicator(tz: tzinfo | None = None) -> None:
    """Render the auto-refresh chip and a timer that keeps it in sync.

    ``tz`` formats the "last update" time in the user's configured timezone; it
    is passed from :mod:`investment_dashboard.ui.layout` (which already resolves
    it for the header clock) to avoid opening a DB session on every poll.

    The chip is clickable: a tap forces an immediate price pull (replacing the
    old standalone refresh button). A thin top bar (``#inv-refreshbar``) pulses
    while any background refresh is running so the auto-update is visible at the
    very top of the page, not only in the header chip.
    """
    from nicegui import ui  # noqa: PLC0415 - needs a NiceGUI page context

    from investment_dashboard.services import refresh_status  # noqa: PLC0415

    # Thin top-of-page progress bar — pulses while a refresh runs. Rendered once
    # per page; toggled via its CSS class from the poll below.
    ui.add_body_html('<div id="inv-refreshbar" aria-hidden="true"></div>')

    def _force_refresh() -> None:
        from investment_dashboard.services import auto_refresh  # noqa: PLC0415

        auto_refresh.run_in_background("Manual refresh", force=True)
        ui.notify("Refreshing prices…", type="ongoing", timeout=1500)

    with (
        ui.row()
        .classes("items-center no-wrap inv-refresh-chip cursor-pointer")
        .on("click", _force_refresh) as chip
    ):
        icon = ui.icon("sync").classes("inv-refresh-icon")
        label = ui.label("Live").classes("inv-refresh-label")
    tip = ui.tooltip("Automatic price updates are on — click to refresh now")

    # Force a first paint regardless of the initial sequence value.
    state = {"seq": -1}

    def _set_topbar(active: bool) -> None:
        # Toggle the top bar's active class straight on the DOM node so it
        # animates without a server round-trip per frame.
        ui.run_javascript(
            "var b=document.getElementById('inv-refreshbar');"
            f"if(b)b.classList.toggle('is-active',{str(active).lower()});"
        )

    def _poll() -> None:
        snap = refresh_status.snapshot()
        if snap.seq == state["seq"]:
            return
        state["seq"] = snap.seq
        if snap.active:
            icon.classes(add="inv-refresh-spin")
            label.set_text("Updating\u2026")
            chip.classes(add="inv-refresh-active")
            tip.set_text("Pulling fresh prices\u2026")
            _set_topbar(True)
            return
        icon.classes(remove="inv-refresh-spin")
        chip.classes(remove="inv-refresh-active")
        label.set_text("Live")
        _set_topbar(False)
        if snap.last_update_at is not None:
            when = snap.last_update_at
            if tz is not None:
                when = when.astimezone(tz)
            tip.set_text(
                f"Automatic price updates on \u00b7 last update {when:%H:%M:%S} "
                "\u00b7 click to refresh now"
            )
        else:
            tip.set_text("Automatic price updates are on — click to refresh now")

    _poll()
    ui.timer(POLL_INTERVAL_SECONDS, _poll)
