"""job_runner: single flight, heavy mutex, results, events."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from typing import Any

import pytest

from investment_dashboard.services import job_runner, live_bus


@pytest.fixture(autouse=True)
def events(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, Any]]]:
    job_runner.reset_for_tests()
    seen: list[dict[str, Any]] = []
    monkeypatch.setattr(live_bus.bus, "publish", seen.append)
    yield seen
    job_runner.reset_for_tests()


def _wait(run_id: str) -> job_runner.Run:
    for _ in range(200):
        run = job_runner.get_run(run_id)
        assert run is not None
        if run.status != "running":
            return run
        threading.Event().wait(0.01)
    raise AssertionError("job did not finish")


def test_runs_and_records_result(events: list[dict[str, Any]]) -> None:
    run = job_runner.start("a", lambda p: {"got": p["x"]}, {"x": 1}, actor="t", persist=False)
    done = _wait(run.id)
    assert done.status == "succeeded"
    assert done.result == {"got": 1}
    # The run is stored as finished just before its event is published, so
    # wait for the event instead of racing the worker thread.
    for _ in range(200):
        if len(events) >= 2:
            break
        threading.Event().wait(0.01)
    assert [e["status"] for e in events] == ["running", "succeeded"]
    assert job_runner.recent()[0].id == run.id


def test_failure_keeps_message_only() -> None:
    def boom(_p: dict[str, Any]) -> None:
        raise RuntimeError("nope")

    run = job_runner.start("b", boom, actor="t", persist=False, wait=True)
    assert run.status == "failed"
    assert run.error == "RuntimeError: nope"


def test_single_flight_and_heavy_mutex() -> None:
    gate = threading.Event()
    started = threading.Event()

    def slow(_p: dict[str, Any]) -> None:
        started.set()
        gate.wait(5)

    first = job_runner.start("heavy1", slow, actor="t", heavy=True, persist=False)
    assert started.wait(5)
    assert job_runner.heavy_busy() == "heavy1"
    with pytest.raises(job_runner.JobBusyError):
        job_runner.start("heavy1", slow, actor="t", persist=False)
    with pytest.raises(job_runner.JobBusyError):
        job_runner.start("heavy2", slow, actor="t", heavy=True, persist=False)
    light = job_runner.start("light", lambda _p: None, actor="t", persist=False, wait=True)
    assert light.status == "succeeded"
    gate.set()
    assert _wait(first.id).status == "succeeded"
    assert job_runner.heavy_busy() is None
