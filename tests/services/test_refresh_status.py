"""Tests for the in-memory automatic-refresh activity tracker."""

from __future__ import annotations

import threading

import pytest

from investment_dashboard.services import refresh_status


@pytest.fixture(autouse=True)
def _reset_refresh_status() -> None:
    refresh_status.reset()
    yield
    refresh_status.reset()


def test_starts_idle() -> None:
    snap = refresh_status.snapshot()
    assert snap.active is False
    assert snap.source is None
    assert snap.seq == 0
    assert snap.last_update_at is None


def test_begin_marks_active_and_advances_sequence() -> None:
    refresh_status.begin("Live price refresh")
    snap = refresh_status.snapshot()
    assert snap.active is True
    assert snap.source == "Live price refresh"
    assert snap.seq == 1


def test_finish_with_update_records_timestamp_and_clears_active() -> None:
    refresh_status.begin("Startup data refresh")
    refresh_status.finish("Startup data refresh", updated=True)
    snap = refresh_status.snapshot()
    assert snap.active is False
    assert snap.source is None
    assert snap.last_update_at is not None
    assert snap.seq == 2


def test_finish_without_update_leaves_timestamp() -> None:
    refresh_status.begin("Live price refresh")
    refresh_status.finish("Live price refresh", updated=False)
    snap = refresh_status.snapshot()
    assert snap.active is False
    assert snap.last_update_at is None


def test_overlapping_refreshes_stay_active_until_all_finish() -> None:
    refresh_status.begin("Startup data refresh")
    refresh_status.begin("Live price refresh")
    assert refresh_status.snapshot().active is True

    refresh_status.finish("Live price refresh", updated=False)
    # One refresh is still running, so the chip must keep showing activity.
    assert refresh_status.snapshot().active is True

    refresh_status.finish("Startup data refresh", updated=True)
    assert refresh_status.snapshot().active is False


def test_finish_never_drives_depth_negative() -> None:
    # A stray finish (without a matching begin) must not wedge the state below 0.
    refresh_status.finish("Live price refresh", updated=False)
    assert refresh_status.snapshot().active is False
    refresh_status.begin("Live price refresh")
    assert refresh_status.snapshot().active is True


def test_thread_safe_under_concurrent_begin_finish() -> None:
    def _worker() -> None:
        for _ in range(200):
            refresh_status.begin("Live price refresh")
            refresh_status.finish("Live price refresh", updated=True)

    threads = [threading.Thread(target=_worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    snap = refresh_status.snapshot()
    assert snap.active is False
    assert snap.seq == 8 * 200 * 2
    assert snap.last_update_at is not None
