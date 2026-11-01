"""Manual-refresh spinner floor for the Settings refresh buttons.

Guards the local-app counterpart of the web companion's "manual refresh
feedback was invisible on mobile" fix: a refresh whose prices/FX are already
current returns in a few milliseconds (the service early-returns with no
network call), so the in-place button spinner must be held for a perceptible
minimum instead of flashing for less than a frame.
"""

from __future__ import annotations

from investment_dashboard.ui.pages.settings import (
    MANUAL_REFRESH_MIN_FEEDBACK_SECONDS,
    _remaining_feedback_delay,
)


def test_cache_fast_refresh_is_floored_to_minimum() -> None:
    # A near-instant (cache-served) refresh keeps the spinner up for the floor.
    assert _remaining_feedback_delay(0.0) == MANUAL_REFRESH_MIN_FEEDBACK_SECONDS
    assert _remaining_feedback_delay(0.01) == MANUAL_REFRESH_MIN_FEEDBACK_SECONDS - 0.01


def test_already_slow_refresh_adds_no_artificial_delay() -> None:
    # Work that already exceeded the floor must not be delayed further.
    assert _remaining_feedback_delay(MANUAL_REFRESH_MIN_FEEDBACK_SECONDS) == 0.0
    assert _remaining_feedback_delay(MANUAL_REFRESH_MIN_FEEDBACK_SECONDS + 1.0) == 0.0


def test_delay_is_never_negative() -> None:
    assert _remaining_feedback_delay(10.0) >= 0.0
