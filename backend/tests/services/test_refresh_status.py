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


def test_progress_defaults_are_inert() -> None:
    snap = refresh_status.snapshot()
    assert snap.historical is False
    assert snap.progress_total == 0
    assert snap.progress_done == 0
    assert snap.progress_label is None


def test_set_progress_marks_historical_and_records_stage() -> None:
    refresh_status.begin("Cache reset re-download")
    refresh_status.set_progress(2, 7, "Prices")
    snap = refresh_status.snapshot()
    assert snap.active is True
    assert snap.historical is True
    assert snap.progress_done == 2
    assert snap.progress_total == 7
    assert snap.progress_label == "Prices"


def test_set_progress_advances_sequence() -> None:
    before = refresh_status.sequence()
    refresh_status.set_progress(1, 7, "Exchange rates")
    assert refresh_status.sequence() == before + 1


def test_finish_clears_historical_progress() -> None:
    refresh_status.begin("Cache reset re-download")
    refresh_status.set_progress(7, 7, "Daily snapshots")
    refresh_status.finish("Cache reset re-download", updated=True)
    snap = refresh_status.snapshot()
    assert snap.active is False
    assert snap.historical is False
    assert snap.progress_total == 0
    assert snap.progress_done == 0
    assert snap.progress_label is None


def test_progress_held_while_an_overlapping_refresh_runs() -> None:
    # The historic download and a quick live tick can overlap; the progress must
    # survive until the *last* refresh finishes, not the first.
    refresh_status.begin("Cache reset re-download")
    refresh_status.set_progress(3, 7, "Prices")
    refresh_status.begin("Live price refresh")
    refresh_status.finish("Live price refresh", updated=False)
    snap = refresh_status.snapshot()
    assert snap.active is True
    assert snap.historical is True
    assert snap.progress_done == 3
    refresh_status.finish("Cache reset re-download", updated=True)
    assert refresh_status.snapshot().historical is False


# -- live events (``/api/stream``) ---------------------------------------------


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    from investment_dashboard.services import live_bus

    events: list[dict[str, object]] = []
    monkeypatch.setattr(live_bus.bus, "publish", events.append)
    return events


def test_begin_and_finish_publish_started_and_finished(
    published: list[dict[str, object]],
) -> None:
    from investment_dashboard.api.schemas.stream import RefreshFinishedEvent, RefreshStartedEvent

    refresh_status.begin("Manual refresh")
    refresh_status.finish("Manual refresh", updated=True)
    assert [e["type"] for e in published] == ["refresh_started", "refresh_finished"]
    RefreshStartedEvent.model_validate(published[0])
    finished = RefreshFinishedEvent.model_validate(published[1])
    assert finished.updated is True
    assert finished.last_update_at is not None
    assert published[0]["source"] == "Manual refresh"


def test_overlapping_refreshes_announce_outermost_only(
    published: list[dict[str, object]],
) -> None:
    refresh_status.begin("a")
    refresh_status.begin("b")
    refresh_status.finish("b", updated=False)
    assert [e["type"] for e in published] == ["refresh_started"]
    refresh_status.finish("a", updated=False)
    assert [e["type"] for e in published] == ["refresh_started", "refresh_finished"]
    assert published[-1]["updated"] is False
    assert published[-1]["last_update_at"] is None


def test_set_progress_publishes_progress(published: list[dict[str, object]]) -> None:
    from investment_dashboard.api.schemas.stream import RefreshProgressEvent

    refresh_status.set_progress(2, 5, "prices")
    event = RefreshProgressEvent.model_validate(published[-1])
    assert (event.progress_done, event.progress_total, event.progress_label) == (2, 5, "prices")
    assert event.historical is True


def test_publish_failure_never_breaks_a_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    from investment_dashboard.services import live_bus

    def boom(_event: object) -> None:
        raise RuntimeError("bus down")

    monkeypatch.setattr(live_bus.bus, "publish", boom)
    refresh_status.begin("x")
    refresh_status.finish("x", updated=True)
    assert refresh_status.snapshot().active is False
