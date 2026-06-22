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

import time
from datetime import tzinfo

#: How often each client re-reads the refresh state. Cheap (an in-memory read),
#: so a short interval keeps the chip feeling live without meaningful cost.
POLL_INTERVAL_SECONDS = 1.5

#: If a user-initiated refresh hasn't finished within this window, repaint the
#: page anyway ("page first") so it never feels stuck, then reload once more when
#: the fresh prices finally land. Comfortably above one poll interval.
MANUAL_REPAINT_AFTER_SECONDS = 3.0

#: Process-local handoff: set when an early "page first" repaint fired while a
#: user-initiated refresh was still running, so the freshly loaded page knows to
#: reload again the moment that refresh completes. Single-user desktop app, so a
#: single in-flight handoff is sufficient.
_pending_completion_reload = {"armed": False}


def decide_reload(
    pending: dict[str, float | int | bool],
    current_seq: int,
    *,
    active: bool,
    now: float,
) -> str | None:
    """Decide whether a user-initiated refresh should reload the page.

    Pure (no side effects) so it can be unit-tested. ``pending`` is the per-page
    bookkeeping armed on click (``since_seq`` = the activity counter at click,
    ``repaint_at`` = monotonic deadline for the "page first" fallback, 0 to
    disable). Returns:

    * ``"complete"`` — the refresh finished (idle again, counter advanced) and
      the page should reload to show the fresh prices;
    * ``"repaint"`` — the refresh is slow; repaint now and reload again later;
    * ``None`` — nothing to do yet.
    """
    if not pending["active"]:
        return None
    if not active and current_seq > pending["since_seq"]:
        return "complete"
    repaint_at = pending["repaint_at"]
    if repaint_at and now >= repaint_at:
        return "repaint"
    return None


def install_header_indicator(tz: tzinfo | None = None) -> None:  # noqa: PLR0915 - one cohesive widget builder
    """Render the auto-refresh chip and a timer that keeps it in sync.

    ``tz`` formats the "last update" time in the user's configured timezone; it
    is passed from :mod:`investment_dashboard.ui.layout` (which already resolves
    it for the header clock) to avoid opening a DB session on every poll.

    The chip is clickable: a tap forces an immediate price pull *and* reloads the
    page so the fresh figures actually become visible (a background pull alone
    updates the DB but not the already-rendered server page). The reload is
    smart: if prices land quickly the page reloads once they're in; if they take
    a while the page repaints promptly ("page first") and reloads again the
    moment the prices arrive. A thin top bar (``#inv-refreshbar``) pulses while
    any background refresh is running.
    """
    from nicegui import ui  # noqa: PLC0415 - needs a NiceGUI page context

    from investment_dashboard.services import refresh_status  # noqa: PLC0415

    # Thin top-of-page progress bar — pulses while a refresh runs. Rendered once
    # per page; toggled via its CSS class from the poll below.
    ui.add_body_html('<div id="inv-refreshbar" aria-hidden="true"></div>')

    # Per-client bookkeeping for a user-initiated update. ``since_seq`` is the
    # activity counter captured when the user clicked; the refresh is "done" once
    # the state is idle and the counter has advanced past it. ``repaint_at`` is
    # the monotonic deadline for the "page first" fallback (0 = disabled).
    pending: dict[str, float | int | bool] = {
        "active": False,
        "since_seq": -1,
        "repaint_at": 0.0,
    }

    def _arm_pending(*, with_repaint: bool) -> None:
        snap = refresh_status.snapshot()
        pending["active"] = True
        pending["since_seq"] = snap.seq
        pending["repaint_at"] = (
            time.monotonic() + MANUAL_REPAINT_AFTER_SECONDS if with_repaint else 0.0
        )

    # If a previous page repainted early ("page first") while a user-initiated
    # refresh was still running, finish the job here: reload once it completes.
    if _pending_completion_reload["armed"]:
        _pending_completion_reload["armed"] = False
        if refresh_status.snapshot().active:
            _arm_pending(with_repaint=False)

    def _force_refresh() -> None:
        from investment_dashboard.services import auto_refresh  # noqa: PLC0415

        _arm_pending(with_repaint=True)
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

    def _maybe_handle_pending() -> bool:
        """Reload the page when a user-initiated refresh warrants it.

        Returns ``True`` if a reload was triggered (the caller should stop).
        """
        if not pending["active"]:
            return False
        snap = refresh_status.snapshot()
        decision = decide_reload(pending, snap.seq, active=snap.active, now=time.monotonic())
        if decision is None:
            return False
        pending["active"] = False
        # A "page first" repaint hands the final completion-reload to the new page.
        if decision == "repaint":
            _pending_completion_reload["armed"] = True
        ui.navigate.reload()
        return True

    def _poll() -> None:
        if _maybe_handle_pending():
            return
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
