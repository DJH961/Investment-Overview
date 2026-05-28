"""Unit tests for the in-memory provider-status tracker."""

from __future__ import annotations

import threading

import pytest

from investment_dashboard.services import provider_status


@pytest.fixture(autouse=True)
def _clean_state() -> None:
    provider_status.reset()
    yield
    provider_status.reset()


def test_record_and_get_status() -> None:
    provider_status.record("yfinance", "ok", "all good")
    event = provider_status.get_status("yfinance")
    assert event is not None
    assert event.provider == "yfinance"
    assert event.status == "ok"
    assert event.message == "all good"


def test_get_status_unknown_provider_returns_none() -> None:
    assert provider_status.get_status("nope") is None


def test_latest_overwrites_previous_event() -> None:
    provider_status.record("yfinance", "ok", "first")
    provider_status.record("yfinance", "error", "second")
    latest = provider_status.get_status("yfinance")
    assert latest is not None
    assert latest.status == "error"
    assert latest.message == "second"


def test_log_returns_newest_first_and_respects_limit() -> None:
    for i in range(5):
        provider_status.record("yfinance", "ok", f"msg{i}")
    events = provider_status.get_log(limit=3)
    assert [e.message for e in events] == ["msg4", "msg3", "msg2"]


def test_log_is_bounded() -> None:
    for i in range(200):
        provider_status.record("yfinance", "ok", f"msg{i}")
    events = provider_status.get_log()
    assert len(events) <= 50
    # Newest first, so first entry must be the very last we recorded.
    assert events[0].message == "msg199"


def test_all_latest_returns_per_provider_snapshot() -> None:
    provider_status.record("yfinance", "ok", "y-ok")
    provider_status.record("frankfurter", "error", "f-err")
    latest = provider_status.all_latest()
    assert set(latest.keys()) == {"yfinance", "frankfurter"}
    assert latest["yfinance"].status == "ok"
    assert latest["frankfurter"].status == "error"


def test_record_is_thread_safe() -> None:
    def worker(prefix: str) -> None:
        for i in range(100):
            provider_status.record("yfinance", "ok", f"{prefix}-{i}")

    threads = [threading.Thread(target=worker, args=(p,)) for p in ("a", "b", "c", "d")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # 4 threads * 100 records = 400 calls, but log is capped at 50.
    log = provider_status.get_log()
    assert len(log) == 50
    # Latest must still be set.
    assert provider_status.get_status("yfinance") is not None
