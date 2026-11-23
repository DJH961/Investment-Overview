"""Single-flight reads and the post-tick cache warm-up."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.db import ledger_session_scope
from investment_dashboard.readmodels import overview as overview_rm
from investment_dashboard.services import read_cache
from investment_dashboard.services.live_bus import LiveBus

from ._seed import seed_ledger


@pytest.fixture
def seeded(api_db: object) -> Iterator[None]:
    with ledger_session_scope() as session:
        seed_ledger(session)
    return


def test_concurrent_identical_reads_compute_once() -> None:
    calls = {"n": 0}
    start = threading.Barrier(5)

    @read_cache.cached_read
    def slow(x: int = 0) -> int:
        calls["n"] += 1
        time.sleep(0.3)
        return calls["n"]

    results: list[int] = []

    def worker() -> None:
        start.wait()
        results.append(slow(x=1))

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert calls["n"] == 1
    assert results == [1] * 5


def test_waiters_recompute_when_the_leader_fails() -> None:
    calls = {"n": 0}
    gate = threading.Event()

    @read_cache.cached_read
    def flaky(x: int = 0) -> int:
        calls["n"] += 1
        if calls["n"] == 1:
            gate.wait(2)
            raise RuntimeError("boom")
        return 42

    outcome: dict[str, object] = {}

    def leader() -> None:
        try:
            flaky(x=1)
        except RuntimeError as exc:
            outcome["leader"] = exc

    def waiter() -> None:
        outcome["waiter"] = flaky(x=1)

    t1 = threading.Thread(target=leader)
    t1.start()
    time.sleep(0.1)
    t2 = threading.Thread(target=waiter)
    t2.start()
    time.sleep(0.1)
    gate.set()
    t1.join()
    t2.join()
    assert isinstance(outcome["leader"], RuntimeError)
    assert outcome["waiter"] == 42


def test_tick_then_warm_makes_overview_both_a_cache_hit(
    api_client: TestClient, seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}
    real = overview_rm.build_overview_both

    def counting(*args: object, **kwargs: object) -> object:
        calls["n"] += 1
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(overview_rm, "build_overview_both", counting)
    assert api_client.get("/api/overview/both").status_code == 200
    first = calls["n"]
    assert first == 1  # one pass for EUR + USD (B-013)

    LiveBus().publish({"type": "tick"})  # drops prices + fx dependent entries
    read_cache.warm()
    after_warm = calls["n"]
    assert after_warm == first + 1

    assert api_client.get("/api/overview/both").status_code == 200
    assert calls["n"] == after_warm  # served from the warmed cache


def test_warm_only_rebuilds_reads_a_client_used_and_the_tick_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    built: list[str] = []

    @read_cache.cached_read
    def page_a(session: object = None) -> str:
        built.append("a")
        return "a"

    @read_cache.cached_read
    def page_b(session: object = None) -> str:
        built.append("b")
        return "b"

    def warm_a(session: object) -> None:
        page_a(session=session)

    def warm_b(session: object) -> None:
        page_b(session=session)

    monkeypatch.setattr(read_cache, "_warmers", [warm_a, warm_b])
    monkeypatch.setattr(read_cache, "_warmer_keys", {})
    monkeypatch.setattr(read_cache, "_touched", set())
    monkeypatch.setattr(read_cache, "_cleared", set())

    read_cache.warm()  # first run: every warmer runs once and its keys are learnt
    assert built == ["a", "b"]
    page_a()  # a client reads page A (a cache hit)
    built.clear()

    read_cache.invalidate(read_cache.PRICES)  # a tick
    read_cache.warm()
    assert built == ["a"]  # page B is not open anywhere: not rebuilt

    built.clear()
    read_cache.invalidate(read_cache.PRICES)  # nobody read the warmed A since
    read_cache.warm()
    assert built == []
