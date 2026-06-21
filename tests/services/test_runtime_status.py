"""Tests for the in-memory background-error tracker."""

from __future__ import annotations

import pytest

from investment_dashboard.services import runtime_status


@pytest.fixture(autouse=True)
def _reset_runtime_status() -> None:
    runtime_status.reset()
    yield
    runtime_status.reset()


def test_starts_empty() -> None:
    assert runtime_status.sequence() == 0
    assert runtime_status.latest() is None
    assert runtime_status.recent() == []


def test_record_error_increments_sequence_and_tracks_latest() -> None:
    first = runtime_status.record_error("Live price refresh", "boom")
    assert first.seq == 1
    assert runtime_status.sequence() == 1
    assert runtime_status.latest() == first

    second = runtime_status.record_error("Startup data refresh", "kaboom")
    assert second.seq == 2
    assert runtime_status.sequence() == 2
    assert runtime_status.latest() == second


def test_recent_is_newest_first_and_capped() -> None:
    for i in range(3):
        runtime_status.record_error("src", f"msg-{i}")
    messages = [event.message for event in runtime_status.recent(limit=2)]
    assert messages == ["msg-2", "msg-1"]


def test_log_is_bounded() -> None:
    for i in range(runtime_status._MAX_LOG_ENTRIES + 10):
        runtime_status.record_error("src", f"msg-{i}")
    assert len(runtime_status.recent()) == runtime_status._MAX_LOG_ENTRIES
    # Sequence keeps counting even though older entries are evicted.
    assert runtime_status.sequence() == runtime_status._MAX_LOG_ENTRIES + 10


def test_reset_clears_everything() -> None:
    runtime_status.record_error("src", "boom")
    runtime_status.reset()
    assert runtime_status.sequence() == 0
    assert runtime_status.latest() is None


def test_identical_errors_are_deduplicated_within_window() -> None:
    first = runtime_status.record_error("stderr", "same message")
    second = runtime_status.record_error("stderr", "same message")
    # The repeat is suppressed: same event returned, counter unchanged.
    assert second.seq == first.seq
    assert runtime_status.sequence() == 1
    assert len(runtime_status.recent()) == 1


def test_distinct_messages_are_not_deduplicated() -> None:
    runtime_status.record_error("stderr", "message one")
    runtime_status.record_error("stderr", "message two")
    assert runtime_status.sequence() == 2


def test_dedup_expires_after_window(monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import timedelta

    runtime_status.record_error("stderr", "recurring")
    assert runtime_status.sequence() == 1
    # Shrink the window so the next identical error is treated as new.
    monkeypatch.setattr(runtime_status, "_DEDUP_WINDOW", timedelta(seconds=0))
    runtime_status.record_error("stderr", "recurring")
    assert runtime_status.sequence() == 2
