from __future__ import annotations

import asyncio
import threading
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from investment_dashboard.services.live_bus import LiveBus
from investment_dashboard.services.scheduler import Jobs, Scheduler

ET = ZoneInfo("America/New_York")

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def et(y: int, m: int, d: int, h: int, mi: int = 0) -> datetime:
    return datetime(y, m, d, h, mi, tzinfo=ET).astimezone(UTC)


class Rig:
    def __init__(self, now: datetime) -> None:
        self.now = now
        self.calls: list[str] = []
        self.bus = LiveBus()
        self.fail: set[str] = set()

        def make(name: str) -> Any:
            def job() -> dict[str, Any] | None:
                self.calls.append(name)
                if name in self.fail:
                    raise RuntimeError("boom")
                return {"x": name}

            return job

        self.sched = Scheduler(
            jobs=Jobs(
                tick=make("tick"),
                fx=make("fx"),
                eod=make("eod"),
                interval_seconds=lambda: 60,
                fx_interval=lambda: timedelta(minutes=1),
                prices_due=lambda: self.missing,
            ),
            clock=lambda: self.now,
            bus=self.bus,
        )
        #: What ``prices_service`` would report as still due (missing close / NAV).
        self.missing = False
        # Start with a fresh FX reading so the stock-clock tests see only stock jobs.
        self.sched.state.last_fx = now
        self.sched.state.last_fx_ok = now


async def test_market_open_ticks_every_interval() -> None:
    r = Rig(et(2026, 11, 2, 10))  # Monday
    r.sched.jobs.fx_interval = lambda: timedelta(hours=1)  # keep the FX clock out of it
    assert await r.sched.step() == ["tick"]
    r.now += timedelta(seconds=30)
    assert await r.sched.step() == []
    r.now += timedelta(seconds=31)
    assert await r.sched.step() == ["tick"]
    assert r.calls == ["tick", "tick"]


async def test_fx_follows_its_own_setting_while_stocks_trade() -> None:
    r = Rig(et(2026, 11, 2, 10))  # Monday, both markets open
    r.sched.jobs.fx_interval = lambda: timedelta(minutes=5)
    ran: list[str] = []
    for _ in range(11):  # minutes 0..10
        ran += await r.sched.step()
        r.now += timedelta(minutes=1)
    assert ran.count("tick") == 11  # every live interval (60 s)
    assert ran.count("fx") == 2  # at 5 and 10 min, as set


async def test_after_close_runs_eod_once_then_fx() -> None:
    r = Rig(et(2026, 11, 2, 16, 30))
    sub = r.bus.subscribe()
    assert await r.sched.step() == ["eod"]
    ev = await asyncio.wait_for(sub.get(), 1)
    assert ev["type"] == "refresh"
    assert ev["market_state"] == "closed"
    assert await r.sched.step() == []  # eod done, fx + prices stamped by eod
    r.now += timedelta(minutes=1)
    assert await r.sched.step() == ["fx"]  # currencies still trade: every minute
    assert (await asyncio.wait_for(sub.get(), 1))["type"] == "fx"
    r.now += timedelta(minutes=9)
    assert await r.sched.step() == ["fx"]  # every close is in: no price pull at all


async def test_closed_market_pulls_only_what_is_missing() -> None:
    # Tuesday 23:00 New York: stocks closed, currencies open -> FX every minute,
    # prices only while something (here a NAV) is still missing.
    r = Rig(et(2026, 11, 3, 23))
    assert await r.sched.step() == ["eod"]
    r.missing = True
    ran: list[str] = []
    for _ in range(10):
        r.now += timedelta(minutes=1)
        ran += await r.sched.step()
    assert ran.count("fx") == 10
    assert ran.count("tick") == 10  # asked every minute; the TTL spaces the real pulls
    r.missing = False  # the NAV landed
    ran = []
    for _ in range(10):
        r.now += timedelta(minutes=1)
        ran += await r.sched.step()
    assert ran.count("tick") == 0
    assert ran.count("fx") == 10


async def test_weekend_fetches_nothing_once_fridays_rate_is_in() -> None:
    w = Rig(et(2026, 11, 7, 12))  # Saturday noon
    w.sched.state.last_fx_ok = et(2026, 11, 6, 17, 5)  # read after Friday's 17:00 close
    assert await w.sched.step() == ["eod"]
    ran: list[str] = []
    for _ in range(60):
        w.now += timedelta(minutes=1)
        ran += await w.sched.step()
    assert ran == []


async def test_weekend_retries_a_missing_rate_until_it_lands() -> None:
    w = Rig(et(2026, 11, 7, 12))  # Saturday, e.g. right after a restart / outage
    w.sched.state.last_fx = w.sched.state.last_fx_ok = None
    w.sched.state.last_eod_session = et(2026, 11, 6, 17).date()
    w.fail.add("fx")
    assert await w.sched.step() == ["fx"]  # fails
    w.now += timedelta(minutes=1)
    w.fail.clear()
    assert await w.sched.step() == ["fx"]  # retried, now good
    w.now += timedelta(minutes=5)
    assert await w.sched.step() == []  # Friday's rate is in: nothing until Sunday


async def test_unchanged_check_keeps_the_read_cache() -> None:
    from investment_dashboard.services import read_cache

    r = Rig(et(2026, 11, 3, 23))
    same = {"total_value_eur": "100", "fx_eur_usd": "1.1", "prices": {"A": 1}, "point": None}
    r.sched.jobs.tick = lambda: dict(same)
    r.sched.jobs.fx_interval = lambda: timedelta(days=1)  # only ticks in this test
    sub = r.bus.subscribe()
    await r.sched.step()  # eod
    r.missing = True  # e.g. a NAV not published yet: closed ticks keep checking
    await asyncio.wait_for(sub.get(), 1)
    r.now += timedelta(minutes=10)
    await r.sched.step()  # first closed tick: nothing seen before, so a change
    first = await asyncio.wait_for(sub.get(), 1)
    assert first["type"] == "tick"
    assert "unchanged" not in first
    mid = read_cache.generations()
    r.now += timedelta(minutes=10)
    await r.sched.step()  # same prices and rate again
    second = await asyncio.wait_for(sub.get(), 1)
    assert second["unchanged"] is True
    assert read_cache.generations() == mid


async def test_holiday_and_weekend_only_eod_once() -> None:
    for when in (et(2026, 11, 26, 11), et(2026, 11, 7, 11)):  # Thanksgiving, Saturday
        r = Rig(when)
        assert await r.sched.step() == ["eod"]
        assert await r.sched.step() == []
        assert "tick" not in r.calls


async def test_holiday_market_state() -> None:
    r = Rig(et(2026, 11, 26, 11))
    sub = r.bus.subscribe()
    await r.sched.step()
    assert (await asyncio.wait_for(sub.get(), 1))["market_state"] == "holiday"


async def test_new_session_triggers_eod_again() -> None:
    r = Rig(et(2026, 11, 2, 17))
    await r.sched.step()
    r.now = et(2026, 11, 3, 17)
    assert await r.sched.step() == ["eod"]


async def test_error_resilience_and_no_event_on_failure() -> None:
    r = Rig(et(2026, 11, 2, 10))
    r.fail.add("tick")
    sub = r.bus.subscribe()
    assert await r.sched.step() == ["tick"]
    assert sub.queue.empty()
    r.fail.clear()
    r.now += timedelta(seconds=61)
    await r.sched.step()
    assert (await asyncio.wait_for(sub.get(), 1))["type"] == "tick"


async def test_run_loop_survives_step_errors() -> None:
    r = Rig(et(2026, 11, 2, 10))
    n = 0

    async def sleep(_s: float) -> None:
        nonlocal n
        n += 1
        if n >= 3:
            raise asyncio.CancelledError
        await asyncio.sleep(0)

    boom = {"on": True}
    orig = r.sched.step

    async def step() -> list[str]:
        if boom["on"]:
            boom["on"] = False
            raise RuntimeError("x")
        return await orig()

    r.sched.step = step  # type: ignore[method-assign]
    r.sched.sleep = sleep
    with pytest.raises(asyncio.CancelledError):
        await r.sched.run()
    assert r.calls == ["tick"]


async def test_job_never_overlaps_itself() -> None:
    r = Rig(et(2026, 11, 2, 10))
    gate = threading.Event()
    started = threading.Event()

    def slow() -> None:
        r.calls.append("tick")
        started.set()
        gate.wait(2)

    r.sched.jobs.tick = slow  # type: ignore[assignment]
    first = asyncio.create_task(r.sched._run_job("tick", r.now))
    await asyncio.to_thread(started.wait, 1)
    await r.sched._run_job("tick", r.now)  # skipped: still running
    gate.set()
    await first
    assert r.calls == ["tick"]


def test_tick_freshness_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    from investment_dashboard.api.schemas.stream import TickEvent
    from investment_dashboard.services import refresh_status, scheduler

    refresh_status.reset()
    try:
        open_now = et(2026, 10, 28, 11)
        assert scheduler._price_freshness(open_now) == {
            "last_update_at": None,
            "price_market_at": None,
            "prices_live": False,
        }
        refresh_status.finish("t", updated=True)
        last = refresh_status.snapshot().last_update_at
        assert last is not None
        payload = scheduler._price_freshness(last)
        assert payload["last_update_at"] == last.isoformat()
        TickEvent.model_validate({"ts": last.isoformat(), "market_state": "open", **payload})
    finally:
        refresh_status.reset()


def test_fx_only_update_is_not_live(monkeypatch: pytest.MonkeyPatch) -> None:
    """A fresh FX rate moves "Updated" but never makes stale prices read as live."""
    from investment_dashboard.services import refresh_status, scheduler

    refresh_status.reset()
    try:
        refresh_status.mark_fx_updated()
        last = refresh_status.snapshot().last_update_at
        assert last is not None
        payload = scheduler._price_freshness(last)
        assert payload["last_update_at"] == last.isoformat()
        assert payload["prices_live"] is False
    finally:
        refresh_status.reset()


def test_fx_job_moves_the_updated_stamp(monkeypatch: pytest.MonkeyPatch) -> None:
    from decimal import Decimal

    from investment_dashboard.api.schemas.stream import FxEvent
    from investment_dashboard.services import fx_service, refresh_status, scheduler

    refresh_status.reset()
    monkeypatch.setattr(fx_service, "refresh_live_spot", lambda *a, **k: Decimal("1.08"))
    monkeypatch.setattr(scheduler, "_live_fx", lambda: Decimal("1.08"))
    try:
        out = scheduler.default_fx_job()
        assert out is not None
        last = refresh_status.snapshot().last_update_at
        assert last is not None
        assert out["last_update_at"] == last.isoformat()
        FxEvent.model_validate({"ts": last.isoformat(), "market_state": "closed", **out})
    finally:
        refresh_status.reset()


def test_fx_job_without_a_new_rate_leaves_the_stamp(monkeypatch: pytest.MonkeyPatch) -> None:
    from investment_dashboard.services import fx_service, refresh_status, scheduler

    refresh_status.reset()
    monkeypatch.setattr(fx_service, "refresh_live_spot", lambda *a, **k: None)
    monkeypatch.setattr(fx_service, "active_live_spot", lambda *a, **k: object())
    monkeypatch.setattr(scheduler, "_live_fx", lambda: None)
    try:
        out = scheduler.default_fx_job()
        assert out is not None
        assert out["last_update_at"] is None
        assert refresh_status.snapshot().last_update_at is None
    finally:
        refresh_status.reset()


# -- control: pause, run now, heavy jobs, snapshot ---------------------------------


@pytest.fixture
def no_pauses() -> Any:
    from investment_dashboard.services import scheduler as sched_mod

    sched_mod.reset_pauses_for_tests()
    saved = sched_mod._save_pauses
    sched_mod._save_pauses = lambda: None  # type: ignore[assignment]
    yield sched_mod
    sched_mod._save_pauses = saved  # type: ignore[assignment]
    sched_mod.reset_pauses_for_tests()


async def test_paused_job_is_skipped_until_expiry(no_pauses: Any) -> None:
    r = Rig(et(2026, 11, 2, 10))
    no_pauses.set_pause(["tick"], until=r.now + timedelta(hours=1), now=r.now)
    assert await r.sched.step() == []
    r.now += timedelta(hours=2)  # the pause expired by itself (FX is due again too)
    assert await r.sched.step() == ["tick", "fx"]
    with pytest.raises(ValueError, match="7 days"):
        no_pauses.set_pause(["tick"], until=r.now + timedelta(days=30), now=r.now)
    with pytest.raises(ValueError, match="unknown"):
        no_pauses.set_pause(["nope"], until=None, now=r.now)


async def test_request_run_overrides_due_and_pause(no_pauses: Any) -> None:
    r = Rig(et(2026, 11, 2, 10))
    assert await r.sched.step() == ["tick"]
    no_pauses.set_pause(["fx"], until=r.now + timedelta(hours=1), now=r.now)
    r.sched.request_run("fx")
    assert await r.sched.step() == ["fx"]
    assert r.calls == ["tick", "fx"]
    snap = r.sched.snapshot()
    fx = next(j for j in snap["jobs"] if j["name"] == "fx")
    assert fx["paused_until"] is not None
    assert fx["last_run_at"] is not None
    assert snap["market_state"] == "open"
    with pytest.raises(ValueError, match="unknown"):
        r.sched.request_run("nope")


async def test_heavy_maintenance_job_blocks_market_jobs(no_pauses: Any) -> None:
    r = Rig(et(2026, 11, 2, 10))
    r.sched.jobs.heavy_busy = lambda: "cache.reset"
    assert await r.sched.step() == []
    r.sched.jobs.heavy_busy = lambda: None
    assert await r.sched.step() == ["tick"]


async def test_fx_interval_comes_from_jobs(no_pauses: Any) -> None:
    r = Rig(et(2026, 11, 2, 20))  # after close
    assert await r.sched.step() == ["eod"]
    r.sched.jobs.fx_interval = lambda: timedelta(minutes=5)
    r.now += timedelta(minutes=6)
    assert await r.sched.step() == ["fx"]


def test_eod_job_fetches_the_live_spot_first(monkeypatch: pytest.MonkeyPatch) -> None:
    """The eod job stamps ``last_fx``, so it must really refresh the live EUR/USD
    (it used to refresh only the ECB history, leaving the app on the end-of-day
    rate for a full FX interval after every restart)."""
    from investment_dashboard import boot
    from investment_dashboard.services import scheduler

    calls: list[str] = []
    for name in (
        "_refresh_live_fx",
        "_refresh_fx",
        "_refresh_prices",
        "_refresh_splits",
        "_refresh_benchmark",
        "_refresh_intraday_day",
        "_warm_snapshots",
        "_run_cache_janitor",
    ):
        monkeypatch.setattr(boot, name, lambda n=name: calls.append(n))
    scheduler.default_eod_job()
    assert calls[0] == "_refresh_live_fx"
    assert "_refresh_fx" in calls
