"""Tests for the event-loop stall watchdog safety net.

The watchdog can't be exercised against the live loop in a unit test (it is a
timing loop), so these lock in the pure decision/throttle/reporting surface it
is built from: the stall threshold check, the human-readable message, the
one-report-per-cooldown throttle, and the fact that a report goes out as a
single ``WARNING`` log record (which the logging handler mirrors into the
in-app tracker — so it must not also call ``record_error`` and double-report).
"""

from __future__ import annotations

import logging

import pytest

from investment_dashboard.services import loop_watchdog


def test_is_stall_uses_threshold_inclusively() -> None:
    assert loop_watchdog.is_stall(3.0, 3.0) is True
    assert loop_watchdog.is_stall(5.2, 3.0) is True
    assert loop_watchdog.is_stall(2.9, 3.0) is False
    assert loop_watchdog.is_stall(0.0, 3.0) is False


def test_is_cpu_bound_stall_distinguishes_real_block_from_suspend() -> None:
    # A genuine blocking calculation keeps a core busy for ~the whole lag.
    assert loop_watchdog.is_cpu_bound_stall(5.0, 5.0) is True
    assert loop_watchdog.is_cpu_bound_stall(5.0, 4.0) is True
    # A suspend/deschedule (machine slept / app backgrounded) burns ~no CPU
    # across a long wall-clock lag → not a real stall, must be suppressed.
    assert loop_watchdog.is_cpu_bound_stall(60.0, 0.01) is False
    assert loop_watchdog.is_cpu_bound_stall(5.0, 0.2) is False
    # Right at the half-the-lag boundary counts (inclusive).
    assert loop_watchdog.is_cpu_bound_stall(4.0, 2.0) is True
    # A non-positive lag can never be a stall.
    assert loop_watchdog.is_cpu_bound_stall(0.0, 0.0) is False


def test_stall_message_reports_duration_and_guidance() -> None:
    msg = loop_watchdog.stall_message(4.25)
    assert "4.2s" in msg
    assert "unresponsive" in msg.lower()


def test_throttle_allows_once_per_cooldown() -> None:
    throttle = loop_watchdog._Throttle(cooldown_seconds=30.0)
    assert throttle.allow(now=100.0) is True
    # Within the cooldown: suppressed.
    assert throttle.allow(now=110.0) is False
    assert throttle.allow(now=129.9) is False
    # Past the cooldown: allowed again, and the window resets from there.
    assert throttle.allow(now=130.0) is True
    assert throttle.allow(now=150.0) is False


def test_report_stall_emits_single_warning_without_double_recording(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # The logging handler turns WARNING records into the in-app entry, so the
    # watchdog must report via the log exactly once and never call record_error
    # directly (that would surface the same stall twice).
    with caplog.at_level(logging.WARNING, logger=loop_watchdog.__name__):
        loop_watchdog._report_stall(4.0)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert loop_watchdog.STALL_SOURCE in warnings[0].getMessage()


def test_start_without_running_loop_is_a_noop() -> None:
    # Called outside any event loop it must not raise — install() relies on this
    # so it is safe to wire unconditionally.
    assert loop_watchdog.start() is None
