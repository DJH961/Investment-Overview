"""7.4 lane E scheduler fixes: the duplicate FX fetch, eod honesty (failed steps kept
and shown in Data Health), and the backup-age check. Fake data only."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from investment_dashboard import db as db_module
from investment_dashboard.config import get_settings
from investment_dashboard.db import config_session_scope, dispose_engines, get_ledger_engine
from investment_dashboard.models import ALL_METADATAS
from investment_dashboard.services import backup_service, diagnostics_service, scheduler
from investment_dashboard.services.live_bus import LiveBus
from investment_dashboard.services.scheduler import Jobs, Scheduler

ET = ZoneInfo("America/New_York")

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def app_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    db = tmp_path / "app.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db))
    for tier in ("LEDGER", "CONFIG", "CACHE"):
        monkeypatch.delenv(f"INV_DASHBOARD_{tier}_PATH", raising=False)
    get_settings.cache_clear()
    dispose_engines()
    engine = get_ledger_engine()
    for metadata in ALL_METADATAS:
        metadata.create_all(engine)
    db_module._dirty_state["since"] = None
    try:
        yield db
    finally:
        dispose_engines()
        get_settings.cache_clear()
        db_module._dirty_state["since"] = None


def et(y: int, m: int, d: int, h: int, mi: int = 0) -> datetime:
    return datetime(y, m, d, h, mi, tzinfo=ET).astimezone(UTC)


class Rig:
    def __init__(self, now: datetime, *, tick_every: int = 60) -> None:
        self.now = now
        self.calls: list[str] = []
        self.fail: set[str] = set()
        self.eod_extra: dict[str, Any] | None = None

        def make(name: str) -> Any:
            def job() -> dict[str, Any] | None:
                self.calls.append(name)
                if name in self.fail:
                    raise RuntimeError("boom")
                if name == "eod" and self.eod_extra is not None:
                    return dict(self.eod_extra)
                return {"x": name}

            return job

        self.sched = Scheduler(
            jobs=Jobs(
                tick=make("tick"),
                fx=make("fx"),
                eod=make("eod"),
                interval_seconds=lambda: tick_every,
                fx_interval=lambda: timedelta(minutes=1),
                prices_due=lambda: False,
                backup_due=lambda _now: False,
            ),
            clock=lambda: self.now,
            bus=LiveBus(),
        )


# -- duplicate FX job ------------------------------------------------------------


async def test_a_due_tick_takes_the_fx_fetch_with_it() -> None:
    # Monday 10:00 New York, nothing fetched yet: both clocks are due, but the tick
    # fetches the live EUR/USD spot itself, so the FX job must not run as well.
    r = Rig(et(2026, 11, 2, 10))
    assert await r.sched.step() == ["tick"]
    assert r.calls.count("fx") == 0


async def test_slow_ticks_fast_fx_never_fetch_twice_in_one_pass() -> None:
    # Ticks every 5 minutes, FX every minute: the FX job fills the minutes between
    # ticks and steps aside on a tick minute.
    r = Rig(et(2026, 11, 2, 10), tick_every=300)
    passes: list[list[str]] = []
    for _ in range(11):  # minutes 0..10
        passes.append(await r.sched.step())
        r.now += timedelta(minutes=1)
    assert all(not ("tick" in p and "fx" in p) for p in passes)
    assert r.calls.count("tick") == 3  # minutes 0, 5, 10
    assert r.calls.count("fx") == 8  # minutes 1-4 and 6-9
    assert len(r.calls) == 11  # exactly one live-spot fetch a minute


async def test_after_a_failed_tick_the_fx_job_still_runs() -> None:
    r = Rig(et(2026, 11, 2, 10))
    r.fail.add("tick")
    assert await r.sched.step() == ["tick"]
    r.now += timedelta(minutes=1)
    assert await r.sched.step() == ["tick", "fx"]


async def test_a_paused_tick_leaves_the_fx_job_running(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scheduler, "_save_pauses", lambda: None)
    scheduler.reset_pauses_for_tests()
    r = Rig(et(2026, 11, 2, 10))
    try:
        scheduler.set_pause(["tick"], until=r.now + timedelta(hours=1), now=r.now)
        assert await r.sched.step() == ["fx"]
    finally:
        scheduler.reset_pauses_for_tests()


# -- end-of-day honesty ----------------------------------------------------------


async def test_failed_eod_steps_are_kept_and_persisted(app_db: Path) -> None:
    r = Rig(et(2026, 11, 2, 16, 30))  # Monday after the close
    r.sched.state.last_fx = r.sched.state.last_fx_ok = r.now
    r.eod_extra = {scheduler.EOD_FAILED_STEPS: ["_refresh_prices", "_refresh_hicp"]}
    assert await r.sched.step() == ["eod"]
    eod = next(j for j in r.sched.snapshot()["jobs"] if j["name"] == "eod")
    assert eod["last_failed"] is True
    assert eod["failed_steps"] == ["_refresh_prices", "_refresh_hicp"]
    with config_session_scope() as cfg:
        at, steps = scheduler.load_eod_result(cfg)
        item = diagnostics_service.check_eod_steps(cfg)
    assert at == r.now
    assert steps == ["_refresh_prices", "_refresh_hicp"]
    assert item.key == "eod_steps"
    assert item.severity == "warning"
    assert item.count == 2
    assert item.examples == ("refresh prices", "refresh hicp")
    assert "2 Nov 2026" in item.detail


async def test_a_clean_eod_clears_the_failed_steps(app_db: Path) -> None:
    r = Rig(et(2026, 11, 2, 16, 30))
    r.sched.state.last_fx = r.sched.state.last_fx_ok = r.now
    scheduler.save_eod_result(r.now - timedelta(days=1), ["_refresh_prices"])
    assert await r.sched.step() == ["eod"]
    with config_session_scope() as cfg:
        item = diagnostics_service.check_eod_steps(cfg)
    assert item.severity == "ok"
    assert item.count == 0


async def test_a_raised_eod_job_is_listed(app_db: Path) -> None:
    r = Rig(et(2026, 11, 2, 16, 30))
    r.sched.state.last_fx = r.sched.state.last_fx_ok = r.now
    r.fail.add("eod")
    await r.sched.step()
    with config_session_scope() as cfg:
        item = diagnostics_service.check_eod_steps(cfg)
    assert item.severity == "warning"
    assert item.examples == (scheduler.EOD_JOB_RAISED,)


def test_eod_check_before_any_run(app_db: Path) -> None:
    with config_session_scope() as cfg:
        item = diagnostics_service.check_eod_steps(cfg)
    assert item.severity == "ok"


# -- backup age ------------------------------------------------------------------

NOW = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)


def _backups(monkeypatch: pytest.MonkeyPatch, last: datetime | None) -> None:
    monkeypatch.setattr(backup_service, "is_configured", lambda: True)
    monkeypatch.setattr(backup_service, "last_snapshot_time", lambda: last)


@pytest.mark.parametrize(
    ("age", "severity"),
    [
        (timedelta(hours=5), "ok"),
        (timedelta(days=2), "ok"),
        (timedelta(days=2, minutes=1), "warning"),
        (timedelta(days=7), "warning"),
        (timedelta(days=7, minutes=1), "error"),
    ],
)
def test_backup_age_thresholds(
    monkeypatch: pytest.MonkeyPatch, age: timedelta, severity: str
) -> None:
    _backups(monkeypatch, NOW - age)
    item = diagnostics_service.check_backup_age(now=NOW)
    assert item.key == "backup_age"
    assert item.severity == severity
    assert item.count == (0 if severity == "ok" else 1)


def test_backup_age_detail_names_the_day(monkeypatch: pytest.MonkeyPatch) -> None:
    _backups(monkeypatch, datetime(2026, 11, 14, 3, 0, tzinfo=UTC))
    item = diagnostics_service.check_backup_age(now=NOW)
    assert "11 day(s)" in item.detail
    assert "14 Nov 2026, 03:00 UTC" in item.detail


def test_no_snapshot_yet_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _backups(monkeypatch, None)
    assert diagnostics_service.check_backup_age(now=NOW).severity == "error"


def test_backups_not_set_up_is_not_a_problem(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(backup_service, "is_configured", lambda: False)
    assert diagnostics_service.check_backup_age(now=NOW).severity == "ok"
