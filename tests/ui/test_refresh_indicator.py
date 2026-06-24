"""Unit tests for the pure ``decide_reload`` helper that drives the update
button's "reload the page, then reload again when fresh prices land" behaviour.

The helper is side-effect free so the reload decision can be verified without a
running NiceGUI client.
"""

from __future__ import annotations

from investment_dashboard.ui.refresh_indicator import decide_reload, is_live_now


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


# -- is_live_now ----------------------------------------------------------


from datetime import UTC, datetime, timedelta  # noqa: E402

_NOW = datetime(2026, 6, 22, 18, 0, tzinfo=UTC)


def test_live_when_market_open_and_price_fresh() -> None:
    assert is_live_now(
        market_open=True,
        last_update_at=_NOW - timedelta(seconds=60),
        now=_NOW,
    )


def test_not_live_when_market_closed_even_if_fresh() -> None:
    assert not is_live_now(
        market_open=False,
        last_update_at=_NOW - timedelta(seconds=60),
        now=_NOW,
    )


def test_not_live_when_price_stale() -> None:
    assert not is_live_now(
        market_open=True,
        last_update_at=_NOW - timedelta(seconds=2000),
        now=_NOW,
    )


def test_not_live_when_no_update_recorded() -> None:
    assert not is_live_now(market_open=True, last_update_at=None, now=_NOW)


def test_future_timestamp_is_not_live() -> None:
    # A clock skew that puts the last update in the future should not read live.
    assert not is_live_now(
        market_open=True,
        last_update_at=_NOW + timedelta(seconds=30),
        now=_NOW,
    )


def test_history_progress_percent_clamps_and_rounds() -> None:
    from investment_dashboard.ui.refresh_indicator import history_progress_percent

    assert history_progress_percent(0, 7) == 0
    assert history_progress_percent(7, 7) == 100
    assert history_progress_percent(3, 7) == 43  # 42.857… rounds to 43
    # Out-of-range inputs are clamped rather than overflowing the bar.
    assert history_progress_percent(9, 7) == 100
    assert history_progress_percent(-1, 7) == 0
    # No work to do reads as complete, so the bar never sticks empty.
    assert history_progress_percent(0, 0) == 100


def test_history_progress_text_names_stage_and_counts() -> None:
    from investment_dashboard.ui.refresh_indicator import history_progress_text

    assert history_progress_text(2, 7, "Prices") == "Prices \u00b7 2/7"
    # ``done`` never reads past ``total`` in the caption.
    assert history_progress_text(9, 7, "Snapshots") == "Snapshots \u00b7 7/7"
    # Missing label falls back to a generic heading; zero total drops the count.
    assert history_progress_text(0, 0, None) == "Downloading history"
    assert history_progress_text(1, 0, "Prices") == "Prices"
