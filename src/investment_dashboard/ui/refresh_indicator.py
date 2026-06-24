"""Header chip that shows the app's *automatic* price-refresh activity.

The local app pulls fresh prices on its own (the post-boot deferred refresh and
the periodic live-price tick — see
:mod:`investment_dashboard.services.refresh_status`). Those run in the
background with no visible cue, so the user can't tell the automatic features
are working. This module renders a small "Live / Updated / Updating…" chip into
the header: a per-page :func:`nicegui.ui.timer` polls
:func:`investment_dashboard.services.refresh_status.snapshot` and reflects it —
the icon spins and the label reads "Updating…" while a refresh runs. When idle
the chip reads **"Live"** (tinted with the gain accent, mirroring the web
companion's "market open" badge) only while the US market is open *and* a fresh
price has landed recently; otherwise it reads a neutral **"Updated"** with the
last-update time, because the figures on screen are settled rather than moving.

It is the always-on, "things are working" counterpart to
:mod:`investment_dashboard.ui.runtime_errors`, which only speaks up on failure.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, tzinfo

from investment_dashboard.domain.market_hours import (
    LIVE_PRICE_WINDOW_SECONDS,
    feed_is_fresh,
)

#: How often each client re-reads the refresh state. Cheap (an in-memory read),
#: so a short interval keeps the chip feeling live without meaningful cost.
POLL_INTERVAL_SECONDS = 1.5

#: Re-exported from :mod:`domain.market_hours` so the header chip, the per-row
#: "As Of" badge and the Daily Growth caption all share one definition of how
#: recently a price must have landed to count as "live".
__all__ = [
    "LIVE_PRICE_WINDOW_SECONDS",
    "decide_reload",
    "history_progress_percent",
    "history_progress_text",
    "is_live_now",
]

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


def is_live_now(
    *,
    market_open: bool,
    last_update_at: datetime | None,
    now: datetime,
    window_seconds: float = LIVE_PRICE_WINDOW_SECONDS,
) -> bool:
    """Decide whether the header chip should read "Live" (vs. "Updated").

    Pure (no side effects) so it can be unit-tested. The feed is considered
    *live* only when the market is open **and** at least one fresh price has
    landed within ``window_seconds`` — i.e. the automatic refresh is actively
    pulling current prices. Outside the session, or once the prices we hold have
    gone stale, the chip falls back to "Updated" (the last figures are settled,
    not moving).
    """
    if not market_open:
        return False
    return feed_is_fresh(last_update_at, now, window_seconds=window_seconds)


def history_progress_percent(done: int, total: int) -> int:
    """Fill percentage (0–100, clamped + rounded) for the historic-download bar.

    Pure (no side effects) so it can be unit-tested. ``done``/``total`` are the
    coarse stage counts of a full historic re-download. A non-positive total
    reads as complete, so the bar never sticks empty when there is no work.
    """
    if total <= 0:
        return 100
    ratio = done / total
    clamped = 0.0 if ratio < 0 else 1.0 if ratio > 1 else ratio
    return round(clamped * 100)


def history_progress_text(done: int, total: int, label: str | None) -> str:
    """Caption for the historic-download progress bar (e.g. "Prices · 3/7").

    Pure (no side effects). Falls back to a generic heading when no stage label
    is supplied so the bar always reads sensibly.
    """
    stage = label or "Downloading history"
    if total <= 0:
        return stage
    return f"{stage} \u00b7 {min(done, total)}/{total}"


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

    from investment_dashboard.domain.market_hours import is_us_market_open  # noqa: PLC0415
    from investment_dashboard.services import refresh_status  # noqa: PLC0415

    # Thin top-of-page progress bar — pulses while a refresh runs. Rendered once
    # per page; toggled via its CSS class from the poll below.
    ui.add_body_html('<div id="inv-refreshbar" aria-hidden="true"></div>')

    # Small bottom-corner *determinate* progress bar shown only while a historic
    # re-download is in flight (after a cache reset, or re-opening the app after a
    # long absence). It names the stage and fills as the download advances, so the
    # historic reload is unmistakably visible rather than a silent background pull.
    ui.add_body_html(
        '<div id="inv-history-progress" role="progressbar" aria-label="Downloading price history" '
        'aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">'
        '<div id="inv-history-progress-text"></div>'
        '<div id="inv-history-progress-track"><div id="inv-history-progress-fill"></div></div>'
        "</div>"
    )

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
        label = ui.label("Updated").classes("inv-refresh-label")
        # Bind the tooltip *inside* the chip so it only shows over the chip
        # itself. Created outside this block it would attach to the surrounding
        # header row and pop up over every neighbouring control (theme, help,
        # quit, …).
        tip = ui.tooltip("Automatic price updates are on — click to refresh now")

    # Force a first paint regardless of the initial sequence value. ``view``
    # caches the last applied idle visual ("live"/"updated") so the idle branch
    # — which must re-run every poll because liveness depends on the wall clock,
    # not just the activity ``seq`` — only touches the DOM when it actually
    # changes.
    state: dict[str, object] = {"seq": -1, "view": None}

    def _set_topbar(active: bool) -> None:
        # Toggle the top bar's active class straight on the DOM node so it
        # animates without a server round-trip per frame.
        ui.run_javascript(
            "var b=document.getElementById('inv-refreshbar');"
            f"if(b)b.classList.toggle('is-active',{str(active).lower()});"
        )

    # Track the last-applied history-bar visual so a quiet poll (nothing moved)
    # doesn't keep shipping identical DOM updates over the socket.
    history_state: dict[str, object] = {"shown": None, "pct": -1, "text": None}

    def _update_history_bar(snap: refresh_status.RefreshActivity) -> None:
        # A historic re-download is in flight when a refresh is active *and* it
        # flagged itself as historical with a positive stage total. Anything else
        # (a quick live tick, idle) hides the bar.
        show = bool(snap.active and snap.historical and snap.progress_total > 0)
        pct = history_progress_percent(snap.progress_done, snap.progress_total) if show else 0
        text = history_progress_text(snap.progress_done, snap.progress_total, snap.progress_label)
        if (
            history_state["shown"] == show
            and history_state["pct"] == pct
            and (not show or history_state["text"] == text)
        ):
            return
        history_state["shown"] = show
        history_state["pct"] = pct
        history_state["text"] = text
        # Drive the bar straight on the DOM (id-scoped) so the fill animates and
        # the caption updates without rebuilding any server-side element. ``text``
        # is composed from our own fixed stage labels, so a JSON dump is safe.
        ui.run_javascript(
            "var p=document.getElementById('inv-history-progress');"
            "if(p){"
            f"p.classList.toggle('is-active',{str(show).lower()});"
            f"p.setAttribute('aria-valuenow',{pct});"
            "var f=document.getElementById('inv-history-progress-fill');"
            f"if(f)f.style.width={json.dumps(f'{pct}%')};"
            "var t=document.getElementById('inv-history-progress-text');"
            f"if(t)t.textContent={json.dumps(text)};"
            "}"
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

    def _apply_active() -> None:
        if state["view"] == "active":
            return
        state["view"] = "active"
        icon.classes(remove="inv-refresh-live", add="inv-refresh-spin")
        label.set_text("Updating\u2026")
        chip.classes(remove="inv-refresh-live", add="inv-refresh-active")
        tip.set_text("Pulling fresh prices\u2026")
        _set_topbar(True)

    def _apply_idle(*, live: bool, last_update_at: datetime | None) -> None:
        view = "live" if live else "updated"
        if state["view"] == view:
            return
        state["view"] = view
        icon.classes(remove="inv-refresh-spin")
        chip.classes(remove="inv-refresh-active")
        # Live: tint the chip with the gain accent (matching the web companion's
        # pulsing "market open" badge) so the user can see at a glance that the
        # prices are moving. Settled: the neutral muted chip.
        if live:
            icon.classes(add="inv-refresh-live")
            chip.classes(add="inv-refresh-live")
            label.set_text("Live")
        else:
            icon.classes(remove="inv-refresh-live")
            chip.classes(remove="inv-refresh-live")
            label.set_text("Updated")
        _set_topbar(False)
        if last_update_at is not None:
            when = last_update_at
            if tz is not None:
                when = when.astimezone(tz)
            lead = "Live · prices updating" if live else "Automatic price updates on"
            tip.set_text(f"{lead} \u00b7 last update {when:%H:%M:%S} \u00b7 click to refresh now")
        else:
            tip.set_text("Automatic price updates are on — click to refresh now")

    def _poll() -> None:
        # Drive the historic-download bar first, every tick, so it keeps filling
        # even while the chip sits on its cached "Updating…" visual.
        _update_history_bar(refresh_status.snapshot())
        if _maybe_handle_pending():
            return
        snap = refresh_status.snapshot()
        if snap.active:
            state["seq"] = snap.seq
            _apply_active()
            return
        # Idle: re-evaluate "Live vs Updated" every tick because it turns on the
        # wall clock (market open + a recent price pull), not just on the
        # activity counter advancing.
        now = datetime.now(UTC)
        live = is_live_now(
            market_open=is_us_market_open(now),
            last_update_at=snap.last_update_at,
            now=now,
        )
        state["seq"] = snap.seq
        _apply_idle(live=live, last_update_at=snap.last_update_at)

    _poll()
    ui.timer(POLL_INTERVAL_SECONDS, _poll)
