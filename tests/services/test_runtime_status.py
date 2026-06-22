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


def test_dismiss_removes_single_error_but_keeps_sequence() -> None:
    first = runtime_status.record_error("src", "msg-1")
    runtime_status.record_error("src", "msg-2")
    assert runtime_status.dismiss(first.seq) is True
    messages = [e.message for e in runtime_status.recent()]
    assert messages == ["msg-2"]
    # A dismissed error is gone for good; the counter does not rewind.
    assert runtime_status.sequence() == 2
    # Dismissing an unknown seq is a no-op.
    assert runtime_status.dismiss(999) is False


def test_dismiss_all_clears_log_but_preserves_sequence() -> None:
    runtime_status.record_error("src", "a")
    runtime_status.record_error("src", "b")
    assert runtime_status.dismiss_all() == 2
    assert runtime_status.recent() == []
    # Sequence is preserved so the toast watcher won't replay old errors.
    assert runtime_status.sequence() == 2


def test_resolve_clears_only_the_matching_source() -> None:
    runtime_status.record_error("Live price refresh", "stale")
    runtime_status.record_error("Other task", "boom")
    removed = runtime_status.resolve("Live price refresh")
    assert removed == 1
    sources = [e.source for e in runtime_status.recent()]
    assert sources == ["Other task"]
    # Sequence is untouched by a resolve.
    assert runtime_status.sequence() == 2


def test_resolve_then_record_same_source_reappears() -> None:
    runtime_status.record_error("Live price refresh", "stale prices")
    runtime_status.resolve("Live price refresh")
    assert runtime_status.recent() == []
    # A genuinely new failure of the same source surfaces again (dedup window
    # entry for the resolved message was cleared).
    again = runtime_status.record_error("Live price refresh", "stale prices")
    assert [e.seq for e in runtime_status.recent()] == [again.seq]
