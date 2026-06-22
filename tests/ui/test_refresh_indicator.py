"""Unit tests for the pure ``decide_reload`` helper that drives the update
button's "reload the page, then reload again when fresh prices land" behaviour.

The helper is side-effect free so the reload decision can be verified without a
running NiceGUI client.
"""

from __future__ import annotations

from investment_dashboard.ui.refresh_indicator import decide_reload


def _pending(
    *, since_seq: int, repaint_at: float, active: bool = True
) -> dict[str, float | int | bool]:
    return {"active": active, "since_seq": since_seq, "repaint_at": repaint_at}


def test_no_pending_refresh_does_nothing() -> None:
    pending = _pending(since_seq=0, repaint_at=0.0, active=False)
    assert decide_reload(pending, current_seq=5, active=False, now=1000.0) is None


def test_completion_reloads_when_refresh_finished() -> None:
    # Armed at seq 3; the refresh has since finished (idle again) and the
    # activity counter advanced, so the page should reload to show fresh prices.
    pending = _pending(since_seq=3, repaint_at=0.0)
    assert decide_reload(pending, current_seq=4, active=False, now=1000.0) == "complete"


def test_still_running_before_deadline_waits() -> None:
    # Refresh is still active and the "page first" deadline has not passed.
    pending = _pending(since_seq=3, repaint_at=2000.0)
    assert decide_reload(pending, current_seq=3, active=True, now=1000.0) is None


def test_slow_refresh_triggers_early_repaint() -> None:
    # Still running, but past the repaint deadline → repaint now ("page first").
    pending = _pending(since_seq=3, repaint_at=999.0)
    assert decide_reload(pending, current_seq=3, active=True, now=1000.0) == "repaint"


def test_completion_takes_precedence_over_repaint_deadline() -> None:
    # Even past the repaint deadline, a finished refresh reloads fully rather
    # than doing a bare repaint.
    pending = _pending(since_seq=3, repaint_at=1.0)
    assert decide_reload(pending, current_seq=4, active=False, now=1000.0) == "complete"


def test_disabled_repaint_deadline_never_repaints() -> None:
    # repaint_at == 0 disables the early repaint; while still running, wait.
    pending = _pending(since_seq=3, repaint_at=0.0)
    assert decide_reload(pending, current_seq=3, active=True, now=10_000.0) is None
